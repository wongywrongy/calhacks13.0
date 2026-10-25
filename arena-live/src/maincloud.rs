//! Hosted chat orchestration. Only fixed Bitdeer egress; all decisions pass the existing reducers.
use super::*;
use crate::fleet::{self,fleet_session__view};
use serde_json::{json, Value};
use spacetimedb::{procedure, ProcedureContext, ScheduleAt, Timestamp};

#[spacetimedb::env]
pub struct Env {
    pub BITDEER_API_KEY: Option<String>,
    pub BITDEER_COORDINATOR_MODEL: Option<String>,
    pub BITDEER_SPECIALIST_MODEL: Option<String>,
}
const SESSION: &str = "maincloud";
const MODEL: &str = "zai-org/GLM-5.3-Flash";
#[table(accessor=hosted_job)]
#[derive(Clone)]
pub struct Job {
    #[primary_key] id: String,
    #[index(btree)] operation: String,
    turn: String,
    identity: Identity,
    role: String,
    epoch: u64,
    generation: u64,
    agent: u32,
    target: u32,
    step: u32,
    deadline: i64,
    #[index(btree)] state: String,
    policy: u32,
    request: String,
    result: String,
    started: i64,
    finished: i64,
}
#[table(accessor=hosted_budget)]
pub struct HostedBudget { #[primary_key] operation:String, calls:u32 }
#[table(accessor=hosted_alarm,scheduled(hosted_infer))]
pub struct Alarm { #[primary_key] #[auto_inc] id:u64, scheduled_at:ScheduleAt, #[index(btree)] job:String, watchdog:bool }
fn alarm(ctx:&ReducerContext,id:&str,at:i64,watchdog:bool) {
    ctx.db.hosted_alarm().insert(Alarm{id:0,scheduled_at:Timestamp::from_micros_since_unix_epoch(at*1000).into(),job:id.into(),watchdog});
}
fn role(ctx:&ReducerContext)->Result<String,String> {
    let role=fleet::hosted_role(ctx);
    if !["attacker","defender"].contains(&role.as_str()){return Err("Workspace role required".into())} Ok(role)
}
fn current(ctx:&ReducerContext,j:&Job)->Result<(),String> {
    check_chat_epoch(ctx,j.epoch)?;
    check_conversation(ctx,&j.role,j.generation)?;
    fleet::validate_chat_fleet(ctx,j.epoch)?;
    if !fleet::hosted_permission(ctx,j.identity,&j.role){return Err("Workspace permission revoked".into())}
    if now(ctx)>=j.deadline{return Err("operation_timeout".into())}
    if j.agent==0 && j.operation.is_empty() {
        if !ctx.db.backend_chat_turn().id().find(&j.turn).map(|t|["queued","running"].contains(&t.state.as_str())).unwrap_or(false){return Err("cancelled".into())}
    } else if ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)).map(|r|r.state)!=Some("running".into()){return Err("cancelled".into())}
    Ok(())
}
#[reducer]
pub fn send_maincloud_message(ctx:&ReducerContext,key:String,message:String,target:u32,epoch:u64,generation:u64)->Result<(),String>{
    let role=role(ctx)?;
    check_chat_epoch(ctx,epoch)?;check_conversation(ctx,&role,generation)?;fleet::validate_chat_fleet(ctx,epoch)?;
    if key.is_empty()||key.len()>100||!key.chars().all(|c|c.is_ascii_alphanumeric()||"_.:-".contains(c))||message.trim().is_empty()||message.len()>2000{return Err("Invalid message or idempotency key".into())}
    if target>0{fleet::validate_chat_target(ctx,&role,target)?;}
    let request_key=format!("{}:{}:{}:{}",epoch,role,generation,key);
    if let Some(t)=ctx.db.backend_chat_turn().request_key().find(&request_key){
        let v:Value=serde_json::from_str(&t.config).map_err(|_|"Invalid stored turn")?;
        return if v["message"]==message&&v["target"].as_u64().unwrap_or(0)==target as u64{Ok(())}else{Err("Idempotency conflict".into())}
    }
    let control=message.trim().trim_end_matches(['.','!']).to_ascii_lowercase();
    let continuing=["continue","keep going","continue operation","continue the operation"].contains(&control.as_str());
    let pending_turn=ctx.db.backend_chat_turn().scope().filter((role.as_str(),epoch,generation)).find(|t|["queued","running"].contains(&t.state.as_str()));
    if pending_turn.is_some() {
        if !continuing&&!["stop","cancel","pause"].contains(&control.as_str()){return Err("Conversation already pending".into())}
    }
    // shortcut: retain at most 200 hosted turns per role; add archival before long-running hosting.
    if ctx.db.backend_chat_turn().role().filter(role.as_str()).take(200).count()>=200{
        // Safety controls remain available without growing retained history past the cap.
        if ["stop","cancel","pause"].contains(&control.as_str()){cancel_role(ctx,&role);return Ok(())}
        return Err("Session history limit reached; archive before continuing".into())
    }
    let id=ctx.new_uuid_v4().map_err(|_|"Identity generation failed")?.to_string();
    let config=json!({"epoch":epoch,"conversation":generation,"message":message,"target":if target==0{Value::Null}else{json!(target)},"createdAt":now(ctx),"deadline":now(ctx)+30000});
    append_chat_message(ctx,generation,format!("{}:user",request_key),&role,"","operator",message.clone(),target)?;
    if continuing {
        if let Some(op)=ctx.db.backend_chat().scope().filter((role.as_str(),epoch,generation)).map(|op|hydrate_operation(ctx,op)).find(|r|r.epoch==epoch&&["planning","running"].contains(&r.state.as_str())){
            append_chat_message(ctx,generation,format!("{}:reply",id),&role,"","coordinator","Your current operation is continuing within its existing budget. No duplicate agents were created.".into(),0)?;
            ctx.db.backend_chat_turn().insert(ChatTurn{epoch:chat_epoch(ctx),generation:conversation_generation(ctx,&role),id,request_key,role:role.clone(),state:"completed".into(),config:config.to_string(),result:json!({"intent":"answer","operationId":op.id}).to_string(),created:now(ctx),updated:now(ctx)});return Ok(())
        }
        if pending_turn.is_some(){
            append_chat_message(ctx,generation,format!("{}:reply",id),&role,"","coordinator","Your existing request is pending. No duplicate work was scheduled.".into(),0)?;
            ctx.db.backend_chat_turn().insert(ChatTurn{epoch:chat_epoch(ctx),generation:conversation_generation(ctx,&role),id,request_key,role:role.clone(),state:"completed".into(),config:config.to_string(),result:json!({"intent":"answer"}).to_string(),created:now(ctx),updated:now(ctx)});return Ok(())
        }
    }
    if ["stop","cancel","pause"].contains(&control.as_str()) {
        cancel_role(ctx,&role);
        append_chat_message(ctx,generation,format!("{}:reply",id),&role,"","coordinator","Stopped your pending work. In-flight results cannot apply.".into(),0)?;
        ctx.db.backend_chat_turn().insert(ChatTurn{epoch:chat_epoch(ctx),generation:conversation_generation(ctx,&role),id,request_key,role:role.clone(),state:"completed".into(),config:config.to_string(),result:json!({"intent":"answer"}).to_string(),created:now(ctx),updated:now(ctx)});
        return Ok(())
    }
    append_chat_message(ctx,generation,format!("{}:accepted",id),&role,"","coordinator","Objective received. Queued for a bounded plan.".into(),target)?;
    ctx.db.backend_chat_turn().insert(ChatTurn{epoch:chat_epoch(ctx),generation:conversation_generation(ctx,&role),id:id.clone(),request_key,role:role.clone(),state:"queued".into(),config:config.to_string(),result:"{}".into(),created:now(ctx),updated:now(ctx)});
    insert_job(ctx,Job{id:id.clone(),operation:String::new(),turn:id,identity:ctx.sender(),role,epoch,generation,agent:0,target,step:0,deadline:now(ctx)+30000,state:"queued".into(),policy:0,request:String::new(),result:String::new(),started:0,finished:0});
    Ok(())
}
fn cancel_role(ctx:&ReducerContext,role:&str) {
    for mut t in ctx.db.backend_chat_turn().scope().filter((role,chat_epoch(ctx),conversation_generation(ctx,role))).filter(|t|["queued","running"].contains(&t.state.as_str())) {t.state="cancelled".into();t.updated=now(ctx);ctx.db.backend_chat_turn().id().update(t);}
    for r in ctx.db.backend_chat().scope().filter((role,chat_epoch(ctx),conversation_generation(ctx,role))).map(|op|hydrate_operation(ctx,op)).filter(|r|["planning","running"].contains(&r.state.as_str())) {cancel_operation(ctx,r);}

}
pub(super) fn cancel_operation(ctx:&ReducerContext,mut op:ChatOperation){
 let config:Value=serde_json::from_str(&op.config).unwrap_or_default();let mut rows=records(ctx,&op.id);
 let conditions=mission_conditions(ctx,&config,&op.role,&rows);let completed=conditions.iter().filter(|c|c["verified"]==true).count();
 rows.push(json!({"type":"mission","outcome":"cancellation","completed":completed,"total":conditions.len(),"conditions":conditions,"at":now(ctx)}));
 op.result=json!(rows).to_string();op.state="cancelled".into();chat_transition(ctx,&op.id,"cancelled");cleanup_operation(ctx,&op.id);
 let _=append_chat_message(ctx,op.generation,format!("{}:terminal",op.id),&op.role,&op.id,"coordinator",chat_summary("cancelled",&op.result),0);
 store_operation(ctx,op);
}
#[reducer]
pub fn new_maincloud_chat(ctx:&ReducerContext,epoch:u64,generation:u64)->Result<(),String>{
    let r=role(ctx)?;check_chat_epoch(ctx,epoch)?;check_conversation(ctx,&r,generation)?;
    cancel_role(ctx,&r);clear_conversation(ctx,&r);Ok(())
}
#[reducer]
pub fn reset_maincloud_fleet(ctx:&ReducerContext,epoch:u64,demo:bool)->Result<(),String>{
    fleet::hosted_reset(ctx,epoch,demo)?;
    if demo{clear_conversation(ctx,"attacker");clear_conversation(ctx,"defender");}Ok(())
}
fn insert_job(ctx:&ReducerContext,j:Job){
    alarm(ctx,&j.id,now(ctx),false);alarm(ctx,&j.id,j.deadline,true);ctx.db.hosted_job().insert(j);
}
fn tasks_schema(max:u64)->Value {
 json!({"type":"array","minItems":0,"maxItems":4,"items":{"type":"object","additionalProperties":false,"required":["name","specialty","target","targets","objective","goal"],"properties":{"targets":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"integer","minimum":1,"maximum":max}},"goal":{"type":"string","description":"Match the requested end state: recover cleans but leaves isolation; restore also releases clean drones for mission participation.","enum":["recon","capture","spread","contain","recover","restore","harden"]},"name":{"type":"string"},"specialty":{"type":"string"},"target":{"type":"integer","minimum":1,"maximum":max},"objective":{"type":"string"}}}})
}
fn records(ctx:&ReducerContext,id:&str)->Vec<Value> {
 ctx.db.backend_chat().id().find(id.to_string()).map(|op|hydrate_operation(ctx,op)).and_then(|r|serde_json::from_str(&r.result).ok()).unwrap_or_default()
}
fn worker_active(state:&str)->bool { ["queued","running","observing","deciding","executing","waiting"].contains(&state) }
fn latest_worker<'a>(rows:&'a [Value],agent:&Value)->Option<&'a Value> {rows.iter().rev().find(|r|r["type"]=="worker"&&r["agentId"]==*agent)}
fn scope(config:&Value,agent:u32)->Vec<u32> {
 let contract=config["completionConditions"].as_array().and_then(|cs|cs.iter().find(|c|c["agentId"]==agent));
 contract.and_then(|c|c["targets"].as_array()).or_else(||config["scopes"][agent.to_string()].as_array()).map(|a|a.iter().filter_map(|n|n.as_u64().map(|n|n as u32)).collect()).unwrap_or_else(||config["tasks"].as_array().into_iter().flatten().filter(|t|t["agentId"]==agent).filter_map(|t|t["target"].as_u64().map(|n|n as u32)).collect())
}
fn conflict(config:&Value,rows:&[Value],agent:u32,target:u32,goal:&str)->bool {
 config["tasks"].as_array().into_iter().flatten().any(|t|t["agentId"]!=agent&&t["target"]==target&&task_goal(t,"")==goal&&latest_worker(rows,&t["agentId"]).map(|w|worker_active(w["state"].as_str().unwrap_or(""))).unwrap_or(true))
}
fn choices(ctx:&ReducerContext,j:&Job,config:&Value,rows:&[Value])->Vec<Value> {
 let task=config["tasks"].as_array().unwrap().iter().find(|t|t["agentId"]==j.agent).unwrap();
 let goal=task_goal(task,&j.role);
 scope(config,j.agent).into_iter().filter(|target|!conflict(config,rows,j.agent,*target,goal)).filter_map(|target|{
  let options=goal_options(ctx,&j.role,target,goal);
  let last=rows.iter().rev().find(|r|r["agentId"]==j.agent&&r["target"]==target&&r["actionId"].is_string()).unwrap_or(&Value::Null);
  if fleet::battle_goal_done(ctx,goal,target,last){return None}
  Some(json!({"target":target,"options":options}))
 }).collect()
}
fn prompt(ctx:&ReducerContext,j:&Job)->Result<Value,String> {
    let prompts:Value=serde_json::from_str(include_str!("../../shared/fleet-prompts.json")).unwrap();
    let mut input=fleet::hosted_context(ctx,&j.role,if j.agent==0{0}else{j.target});
    input["goalContracts"]=serde_json::from_str(include_str!("../../shared/fleet-goals.json")).unwrap();
    let max=fleet::hosted_context(ctx,&j.role,0)["catalog"]["targetIds"].as_array().ok_or("Fleet missing")?.len() as u64;
    let (system,schema)=if j.agent==0 && !j.operation.is_empty() {
        let op=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
        let config:Value=serde_json::from_str(&op.config).map_err(|_|"Invalid operation")?;
        input["mission"]=config.clone();input["results"]=json!(records(ctx,&j.operation));
        input["eligibleOptions"]=json!(config["tasks"].as_array().unwrap().iter().map(|t|{
          let mut worker=j.clone();worker.agent=t["agentId"].as_u64().unwrap() as u32;
          json!({"agentId":worker.agent,"choices":choices(ctx,&worker,&config,&records(ctx,&j.operation))})
        }).collect::<Vec<_>>());
        (json!("Replan only blocked assignments using their original goals and target scopes. Never expand scope, claim success or replenish budgets. Return revised targets for existing blocked agent IDs, or an empty assignments array when no useful work remains. Avoid teammate conflicts. Include a short explanation grounded in supplied evidence."),json!({"type":"object","additionalProperties":false,"required":["assignments","explanation","evidenceIds"],"properties":{"assignments":{"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":false,"required":["agentId","target"],"properties":{"agentId":{"type":"integer"},"target":{"type":"integer"}}}},"explanation":{"type":"string"},"evidenceIds":{"type":"array","items":{"type":"integer"}}}}))
    }else if j.agent==0 {
        let t=ctx.db.backend_chat_turn().id().find(&j.turn).ok_or("Turn missing")?;
        let v:Value=serde_json::from_str(&t.config).map_err(|_|"Invalid turn")?;
        input["eligibleOptions"]=json!((1..=max as u32).filter_map(|target|{let o=fleet::battle_options(ctx,&j.role,target);if o["actions"].as_array().map(|a|!a.is_empty()).unwrap_or(false){Some(json!({"target":target,"options":o}))}else{None}}).collect::<Vec<_>>());
        input["message"]=v["message"].clone(); input["selectedTarget"]=v["target"].clone();
        let mut history:Vec<_>=ctx.db.backend_chat_message().conversation().filter((j.role.as_str(),j.generation)).filter(|m|!m.key.ends_with(":accepted")).collect();
        history.sort_by_key(|m|m.id);
        input["history"]=json!(history.iter().rev().take(12).map(|m|json!({"speaker":m.speaker,"text":m.text.chars().take(700).collect::<String>(),"target":m.target})).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>());
        input["operations"]=json!(ctx.db.backend_chat().scope().filter((j.role.as_str(),j.epoch,j.generation)).map(|op|hydrate_operation(ctx,op)).filter(|r|r.epoch==j.epoch&&r.generation==j.generation).map(|r|json!({"id":r.id,"state":r.state,"config":serde_json::from_str::<Value>(&r.config).unwrap_or(Value::Null),"results":serde_json::from_str::<Vec<Value>>(&r.result).unwrap_or_default().into_iter().rev().take(8).collect::<Vec<_>>()})).collect::<Vec<_>>().into_iter().rev().take(2).collect::<Vec<_>>());
        (json!(format!("{} Hosted tasks also require targets: 1..8 coordinator-approved catalog IDs including the initial target, restricted to selectedTarget when supplied. Each target list is an immutable completion contract: achieve the typed goal on one listed target. Keep singleton scopes when the objective requires specific individual targets; permit alternatives only when the objective allows them. Choose only targets useful for this objective. Each specialist may retarget within this scope without expanding its typed goal. Reserve distinct target/goal pairs. Budget: 75 seconds from the original request, at most 33 total calls and 8 actions per specialist, including at most two coordinator replans. Define concise observable completion conditions using the typed goals, not model claims. goalContracts.completion defines the exact server predicates and overrides shorthand descriptions.",prompts["coordinator"].as_str().unwrap())),json!({"type":"object","additionalProperties":false,"required":["intent","answer","evidenceIds","tasks"],"properties":{"intent":{"type":"string","enum":["answer","clarify","deploy","replace"]},"answer":{"type":"string","description":"Operator-facing answer or a specific clarification question, never just a routing label."},"evidenceIds":{"type":"array","items":{"type":"integer"}},"tasks":tasks_schema(max)}}))
    }else{
        let r=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
        let v:Value=serde_json::from_str(&r.config).map_err(|_|"Invalid operation")?;
        input["assignment"]=v["tasks"].as_array().unwrap().iter().find(|t|t["agentId"]==j.agent).cloned().ok_or("Assignment missing")?;
        let rows=records(ctx,&j.operation);
        input["memory"]=json!(rows.iter().filter(|r|r["agentId"]==j.agent&&r["type"]!="inference").collect::<Vec<_>>());
        input["teammates"]=json!(v["tasks"].as_array().unwrap().iter().map(|t|json!({"assignment":t,"lifecycle":latest_worker(&rows,&t["agentId"])})).collect::<Vec<_>>());
        input["handoffs"]=json!(rows.iter().filter(|r|r["type"]=="handoff").collect::<Vec<_>>());
        input["decisionsRemaining"]=json!(9-j.step);
        input["deadline"]=json!(j.deadline);input["modelCallsRemaining"]=json!(33-ctx.db.hosted_budget().operation().find(&j.operation).map(|b|b.calls).unwrap_or(33));
        let goal=task_goal(&input["assignment"],&j.role);
        let options=goal_options(ctx,&j.role,j.target,goal);
        input["options"]=options.clone();input["targetChoices"]=json!(choices(ctx,j,&v,&rows));
        let mut allowed:Vec<String>=options["actions"].as_array().unwrap().iter().filter_map(|a|a.as_str().map(str::to_string)).collect();
        allowed.extend(["wait","help","finish"].map(str::to_string));
        let evidence:Vec<_>=input["evidence"].as_array().unwrap().iter().map(|e|e["id"].clone()).collect();
        if !evidence.is_empty()&&input["targetChoices"].as_array().unwrap().iter().any(|c|c["target"]!=j.target&&!c["options"]["actions"].as_array().unwrap().is_empty()){allowed.push("retarget".into());}
        let recipients:Vec<_>=v["tasks"].as_array().unwrap().iter().filter_map(|t|{
            let agent=t["agentId"].as_u64().unwrap() as u32;
            if agent==j.agent||!scope(&v,agent).contains(&j.target)||latest_worker(&rows,&t["agentId"]).map(|w|!worker_active(w["state"].as_str().unwrap_or(""))).unwrap_or(false){return None}
            let fresh:Vec<_>=evidence.iter().filter(|id|!rows.iter().any(|r|r["type"]=="handoff"&&r["agentId"]==j.agent&&r["recipientAgentId"]==agent&&r["evidenceIds"].as_array().map(|ids|ids.contains(id)).unwrap_or(false))).collect();
            if fresh.is_empty(){None}else{Some(json!({"agentId":agent,"evidenceIds":fresh}))}
        }).collect();
        if !recipients.is_empty(){allowed.push("handoff".into());}input["handoffRecipients"]=json!(recipients);
        (json!(format!("{} Choose a useful permitted simulation action, retarget within targetChoices, handoff evidence to a teammate, help to request coordinator reassessment, wait for a scheduled fresh observation, or finish when no useful work remains. Wait resumes; it does not complete the objective. Return kind, target, recipientAgentId (0 unless handoff), explanation (short operator-facing reason), evidenceIds (provided evidence only).",prompts["specialist"].as_str().unwrap().replace("Return only JSON {kind:\"...\"}.", ""))),json!({"type":"object","additionalProperties":false,"required":["kind","target","recipientAgentId","explanation","evidenceIds"],"properties":{"kind":{"type":"string","enum":allowed},"target":{"type":"integer"},"recipientAgentId":{"type":"integer"},"explanation":{"type":"string"},"evidenceIds":{"type":"array","items":{"type":"integer"}}}}))
    };
    let model=if j.agent==0{ctx.env.BITDEER_COORDINATOR_MODEL()}else{ctx.env.BITDEER_SPECIALIST_MODEL()}.unwrap_or(MODEL.into());
    Ok(json!({"model":model,"temperature":0,"max_tokens":if j.agent==0{1536}else{512},"reasoning_effort":"low","response_format":{"type":"json_schema","json_schema":{"name":if j.agent==0{"fleet_plan"}else{"fleet_action"},"strict":true,"schema":schema}},"messages":[{"role":"system","content":json!({"task":system,"role":j.role,"agents":{"min":1,"max":4},"targets":{"min":1,"max":max},"allowed":schema["properties"]["kind"]["enum"]}).to_string()},{"role":"user","content":input.to_string()}]}))
}
fn reserve(ctx:&ReducerContext,id:&str)->Result<Option<Job>,String>{
    let Some(mut j)=ctx.db.hosted_job().id().find(id.to_string())else{return Ok(None)};
    if !["queued","waiting"].contains(&j.state.as_str()){return Ok(None)}
    current(ctx,&j)?;
    if j.state=="waiting" {
        let wake=serde_json::from_str::<Value>(&j.result).ok().and_then(|v|v["wakeAt"].as_i64()).unwrap_or(0);
        if now(ctx)<wake{alarm(ctx,id,wake,false);return Ok(None)}
        j.state="queued".into();
    }
    if j.agent>0 {
        let operation=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
        let config:Value=serde_json::from_str(&operation.config).map_err(|_|"Invalid operation")?;
        let task=config["tasks"].as_array().unwrap().iter().find(|t|t["agentId"]==j.agent).ok_or("Assignment missing")?;
        if task["target"]!=j.target{return Err("Outside assignment".into())}
        let goal=task_goal(task,&j.role);let rows=records(ctx,&j.operation);
        let last=rows.iter().rev().find(|r|r["agentId"]==j.agent&&r["actionId"].is_string()).cloned().unwrap_or(Value::Null);
        if fleet::battle_goal_done(ctx,goal,j.target,&last){close_worker(ctx,&j,"completed","Objective verified by simulation state.");return Ok(None)}
        if j.step>8{close_worker(ctx,&j,"exhausted","Decision budget exhausted.");return Ok(None)}
        let options=goal_options(ctx,&j.role,j.target,goal);
        if crate::fleet::battle_target_pending(ctx,&j.role,j.target,j.agent){
            j.state="waiting".into();j.result=json!({"wakeAt":now(ctx)+1000}).to_string();ctx.db.hosted_job().id().update(j.clone());worker_state(ctx,&j,"waiting","Waiting for a teammate on this target.");alarm(ctx,id,now(ctx)+1000,false);return Ok(None)
        }
        if options["actions"].as_array().map(|a|a.is_empty()).unwrap_or(true)&&!choices(ctx,&j,&config,&rows).iter().any(|c|c["options"]["actions"].as_array().map(|a|!a.is_empty()).unwrap_or(false)){
            if fleet::battle_has_pending(ctx,&j.operation,j.agent)||fleet::battle_target_changing(ctx,j.target){
                j.state="waiting".into();j.result=json!({"wakeAt":now(ctx)+1000}).to_string();ctx.db.hosted_job().id().update(j.clone());
                worker_state(ctx,&j,"waiting","Waiting for a relevant attempt or countermeasure to change.");alarm(ctx,id,now(ctx)+1000,false);return Ok(None)
            }
            close_worker(ctx,&j,"blocked",options["blocker"].as_str().unwrap_or("No useful action remains."));return Ok(None)
        }
        // Discovery is a required observation, with no strategic choice or provider call.
        if options["actions"]==json!(["discover"]){
            fleet::execute_fleet_chat_action(ctx,SESSION.into(),j.operation.clone(),j.step,j.agent,j.target,"discover".into(),fleet::hosted_policy(ctx,j.target)?)?;
            let mut receipt=fleet::hosted_receipt(ctx,&j.id);receipt["decisionSource"]=json!("server_observation");
            complete_action(ctx,&j,"discover",receipt)?;return Ok(None)
        }
    }
    #[cfg(not(feature="mission-fixtures"))]
    if ctx.env.BITDEER_API_KEY().filter(|k|!k.is_empty()).is_none(){return Err("provider_not_configured".into())}
    if ctx.db.hosted_job().state().filter("running").count()>=4{alarm(ctx,id,now(ctx)+250,false);return Ok(None)}
    if !j.operation.is_empty(){
        let mut b=ctx.db.hosted_budget().operation().find(&j.operation).ok_or("Budget missing")?;
        if b.calls>=33{close_worker(ctx,&j,"exhausted","Model budget exhausted.");return Ok(None)}
        b.calls+=1;ctx.db.hosted_budget().operation().update(b);
    }
    if j.agent>0{j.policy=fleet::hosted_policy(ctx,j.target)?;}
    j.request=prompt(ctx,&j)?.to_string();j.state="running".into();j.started=now(ctx);
    alarm(ctx,&j.id,(j.started+20000).min(j.deadline)+1000,true);
    if j.agent>0{worker_state(ctx,&j,"deciding","Choosing the next permitted action.");}
    else if j.operation.is_empty(){let mut turn=ctx.db.backend_chat_turn().id().find(&j.turn).ok_or("Turn missing")?;turn.state="running".into();turn.updated=now(ctx);ctx.db.backend_chat_turn().id().update(turn);}
    ctx.db.hosted_job().id().update(j.clone());Ok(Some(j))
}
fn parse_provider(raw:&str)->Result<Value,String>{
    if raw.len()>65536{return Err("provider_malformed_output".into())}
    let v:Value=serde_json::from_str(raw).map_err(|_|"provider_malformed_output")?;
    let c=&v["choices"][0];let m=&c["message"];
    if !m["refusal"].is_null()&&m["refusal"]!=false||c["finish_reason"]=="content_filter"{return Err("provider_refused".into())}
    if c["finish_reason"]=="length"{return Err("provider_truncated_output".into())}
    if c["finish_reason"]!="stop"{return Err("provider_malformed_output".into())}
    serde_json::from_str(m["content"].as_str().ok_or("provider_malformed_output")?).map_err(|_|"provider_malformed_output".into())
}
fn inference(ctx:&mut ProcedureContext,j:&mut Job)->Result<Value,String>{
    let key=ctx.env.BITDEER_API_KEY().filter(|k|!k.is_empty()).ok_or("provider_not_configured")?;
    let timeout=(j.deadline-j.started).clamp(1,20000) as u64;
    let request=spacetimedb::http::Request::builder().uri("https://api-inference.bitdeer.ai/v1/chat/completions").method("POST").header("Content-Type","application/json").header("Authorization",format!("Bearer {}",key)).extension(spacetimedb::http::Timeout::from(spacetimedb::TimeDuration::from(std::time::Duration::from_millis(timeout)))).body(j.request.clone()).map_err(|_|"provider_transport_error")?;
    let response=ctx.http.send(request).map_err(|e|if e.to_string().to_ascii_lowercase().contains("tim"){"provider_timeout"}else{"provider_transport_error"})?;
    if !response.status().is_success(){return Err(format!("{}: HTTP {}",if response.status().as_u16()==429{"provider_rate_limit"}else{"provider_http_error"},response.status().as_u16()))}
    let raw=response.into_body().into_string_lossy();
    j.result=json!({"provider":provider_metadata(&raw)}).to_string();
    parse_provider(&raw)
}
#[procedure]
pub fn hosted_infer(ctx:&mut ProcedureContext,a:Alarm){
    if ctx.sender()!=ctx.database_identity()||ctx.connection_id().is_some(){return}
    #[cfg(feature="mission-fixtures")]
    { let _=a;return }
    #[allow(unreachable_code)]
    let waiting=ctx.with_tx(|tx| {
        let Some(j)=tx.db.hosted_job().id().find(&a.job)else{return false};
        if j.state!="attempt"{return false}
        if let Err(e)=current(tx,&j){fail(tx,&j,&e);return true}
        let kind=serde_json::from_str::<Value>(&j.result).ok().and_then(|v|v["kind"].as_str().map(str::to_string)).unwrap_or_default();
        let receipt=fleet::hosted_receipt(tx,&j.id);
        if let Err(e)=complete_action(tx,&j,&kind,receipt){fail(tx,&j,&e);return true}
        true
    });
    if waiting{return}
    if a.watchdog {
        ctx.with_tx(|tx|{if let Some(j)=tx.db.hosted_job().id().find(&a.job){
            // Reclaim an abandoned reservation only after the enforced HTTP timeout plus grace.
            if j.state=="running"&&now(tx)>=(j.started+20000).min(j.deadline)+1000{
                fail(tx,&j,if now(tx)>=j.deadline{"operation_timeout"}else{"provider_timeout"});
                let mut saved=tx.db.hosted_job().id().find(&j.id).unwrap();saved.state="failed".into();saved.finished=now(tx);saved.request.clear();tx.db.hosted_job().id().update(saved);
            }else if ["queued","waiting","running","attempt"].contains(&j.state.as_str())&&now(tx)>=j.deadline{fail(tx,&j,"operation_timeout");}
        }});return
    }
    let reserved=ctx.try_with_tx(|tx|reserve(tx,&a.job));
    let mut j=match reserved {Ok(Some(j))=>j,Ok(None)=>return,Err(e)=>{ctx.with_tx(|tx|{if let Some(j)=tx.db.hosted_job().id().find(&a.job){fail(tx,&j,&e);}});return}};
    let result=inference(ctx,&mut j);
    // External I/O is finished. Session, conversation, cancellation, grants and policy are checked again.
    let committed=ctx.try_with_tx(|tx|{
        apply_inference(tx,&j,&result)
    });
    ctx.with_tx(|tx|{
        if let Some(mut saved)=tx.db.hosted_job().id().find(&j.id){
            if let Err(ref e)=committed{if saved.state=="running"&&saved.result.is_empty(){saved.result=j.result.clone();}fail(tx,&saved,e);saved=tx.db.hosted_job().id().find(&j.id).unwrap();}
            if saved.state=="running"{saved.state="failed".into();saved.finished=now(tx);saved.request.clear();tx.db.hosted_job().id().update(saved);}
        }
    });
}
fn apply_inference(ctx:&ReducerContext,j:&Job,result:&Result<Value,String>)->Result<(),String>{
        let saved=ctx.db.hosted_job().id().find(&j.id).ok_or("Job missing")?;
        if saved.state!="running"{return Ok(())}
        current(ctx,&saved)?;
        let value=result.as_ref().map_err(|e|e.clone())?;
        if j.agent==0{if j.operation.is_empty(){commit_plan(ctx,&j,value)?;}else{commit_replan(ctx,&j,value)?;}}else{commit_action(ctx,&j,value)?;}
        let mut saved=ctx.db.hosted_job().id().find(&j.id).unwrap();if saved.state!="attempt"{saved.state="done".into();saved.finished=now(ctx);saved.request.clear();}saved.result=value.to_string();saved.request.clear();ctx.db.hosted_job().id().update(saved);Ok::<_,String>(())
}
fn provider_metadata(raw:&str)->Value {
    if raw.len()>65536{return Value::Null}
    let Ok(v)=serde_json::from_str::<Value>(raw)else{return Value::Null};
    let mut usage=serde_json::Map::new();
    for key in ["prompt_tokens","completion_tokens","total_tokens"] {
        if let Some(n)=v["usage"][key].as_u64(){usage.insert(key.into(),json!(n));}
    }
    json!({"reportedModel":v["model"].as_str().filter(|s|s.len()<=160),"finishReason":v["choices"][0]["finish_reason"].as_str().filter(|s|s.len()<=40),"usage":if usage.is_empty(){Value::Null}else{Value::Object(usage)}})
}
fn metric(ctx:&ReducerContext,j:&Job,error:Option<&str>)->Value{
    let request:Value=serde_json::from_str(&j.request).unwrap_or(Value::Null);
    let model=request["model"].as_str().map(str::to_string).unwrap_or_else(||if j.agent==0{ctx.env.BITDEER_COORDINATOR_MODEL()}else{ctx.env.BITDEER_SPECIALIST_MODEL()}.unwrap_or(MODEL.into()));
    let provider:Value=serde_json::from_str(&j.result).unwrap_or(Value::Null);
    json!({"reportedModel":provider["provider"]["reportedModel"],"usage":provider["provider"]["usage"],"finishReason":provider["provider"]["finishReason"],"type":"inference","source":if cfg!(feature="mission-fixtures"){"Fixture decisions"}else{"Bitdeer"},"stage":if j.agent==0{"coordinator"}else{"specialist"},"agentId":j.agent,"model":model,"requested":j.started>0,"status":if error.is_some(){"failed"}else{"completed"},"error":error,"at":if j.started>0{j.started}else{now(ctx)},"durationMs":if j.started>0{now(ctx)-j.started}else{0}})
}
fn fail(ctx:&ReducerContext,j:&Job,error:&str){
    if !["queued","waiting","running","attempt"].contains(&j.state.as_str()){return}
    let mut saved=j.clone();saved.state=if j.state=="running"{"running"}else{"failed"}.into();saved.result=json!({"error":error}).to_string();if j.state!="running"{saved.finished=now(ctx);saved.request.clear();}ctx.db.hosted_job().id().update(saved);
    // A reset/cancelled generation cannot receive messages, deploy agents, or complete old work.
    if check_chat_epoch(ctx,j.epoch).is_err()||check_conversation(ctx,&j.role,j.generation).is_err(){return}
    if j.agent==0 && j.operation.is_empty() {
        if let Some(mut t)=ctx.db.backend_chat_turn().id().find(&j.turn){if !["queued","running"].contains(&t.state.as_str()){return}t.state="failed".into();t.updated=now(ctx);t.result=json!({"error":error,"metric":metric(ctx,j,Some(error))}).to_string();ctx.db.backend_chat_turn().id().update(t);let _=append_chat_message(ctx,j.generation,format!("{}:reply",j.turn),&j.role,"","coordinator",format!("Decision failed: {}. No fixture fallback was used.",error),0);}
    }else if let Some(mut r)=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)){
        if r.state!="running"{return}
        if serde_json::from_str::<Value>(&j.result).ok().and_then(|v|v["error"].as_str().map(str::to_string)).is_some(){return}
        let mut records:Vec<Value>=serde_json::from_str(&r.result).unwrap_or_default();
        if j.state=="running"&&serde_json::from_str::<Value>(&j.result).ok().and_then(|v|v["error"].as_str().map(str::to_string)).is_none(){records.push(metric(ctx,j,Some(error)));}
        if j.agent>0 {records.push(json!({"type":"worker","agentId":j.agent,"target":j.target,"state":if error=="operation_timeout"{"exhausted"}else{"failed"},"error":error,"at":now(ctx)}));}
        else {records.push(json!({"type":"replan","state":if error=="operation_timeout"{"exhausted"}else{"failed"},"error":error,"at":now(ctx)}));}
        r.result=json!(records).to_string();store_operation(ctx,r);
        cleanup_agent(ctx,&j.operation,j.agent);finish_operation(ctx,&j.operation);
    }
}
fn commit_plan(ctx:&ReducerContext,j:&Job,v:&Value)->Result<(),String>{
    let intent=v["intent"].as_str().ok_or("provider_malformed_output")?;
    let answer=v["answer"].as_str().filter(|s|!s.trim().is_empty()&&s.len()<=2000).ok_or("provider_malformed_output")?;
    if ["answer","clarify","deploy","replace"].contains(&answer.trim().to_ascii_lowercase().as_str()){return Err("provider_invalid_reply".into())}
    let ids=v["evidenceIds"].as_array().filter(|a|a.len()<=16).ok_or("provider_malformed_output")?;
    let request:Value=serde_json::from_str(&j.request).map_err(|_|"Invalid reservation")?;
    let context:Value=serde_json::from_str(request["messages"][1]["content"].as_str().ok_or("Invalid reservation")?).map_err(|_|"Invalid reservation")?;
    if v.as_object().map(|o|o.len())!=Some(4){return Err("provider_malformed_output".into())}
    if !ids.iter().all(|id|context["evidence"].as_array().unwrap().iter().any(|e|e["id"]==*id)){return Err("Invalid evidence reference".into())}
    let tasks=v["tasks"].as_array().ok_or("provider_malformed_output")?;
    let mut operation=String::new();
    if ["deploy","replace"].contains(&intent) {
        if !(1..=4).contains(&tasks.len()){return Err("invalid_plan_size".into())}
        let active=ctx.db.backend_chat().scope().filter((j.role.as_str(),j.epoch,j.generation)).map(|op|hydrate_operation(ctx,op)).find(|r|["planning","running"].contains(&r.state.as_str()));
        if let Some(r)=active {
            if intent!="replace"{return Err("Role operation already active".into())}
            cancel_operation(ctx,r);
        }
        operation=ctx.new_uuid_v4().map_err(|_|"Identity generation failed")?.to_string();
        let t=ctx.db.backend_chat_turn().id().find(&j.turn).ok_or("Turn missing")?;
        let mut config:Value=serde_json::from_str(&t.config).map_err(|_|"Invalid turn")?;
        config["createdAt"]=json!(j.deadline-30000);config["deadline"]=json!(j.deadline+45000);config["maxDecisionsPerAgent"]=json!(8);config["maxModelCalls"]=json!(33);config["tasks"]=json!([]);config["turnId"]=json!(j.turn);
        config["models"]=json!({"coordinator":ctx.env.BITDEER_COORDINATOR_MODEL().unwrap_or(MODEL.into()),"specialist":ctx.env.BITDEER_SPECIALIST_MODEL().unwrap_or(MODEL.into())});
        create_chat_operation(ctx,SESSION.into(),operation.clone(),format!("hosted:{}",j.turn),j.role.clone(),j.epoch,config.to_string())?;
        let mut assignments=tasks.clone();
        let mut scopes=json!({});
        let mut claimed=std::collections::HashSet::new();
        let first_agent=fleet::hosted_next_agent(ctx)?;
        for (index,task) in assignments.iter_mut().enumerate() {
            if task.as_object().map(|t|t.len())!=Some(6)||!goal_valid(&j.role,task["goal"].as_str().unwrap_or(""))||task["objective"].as_str().map(|s|s.len()>300).unwrap_or(true){return Err("provider_malformed_output".into())}
            let id=first_agent.checked_add(index as u32).ok_or("Agent identity exhausted")?;
            if !claimed.insert((task["target"].as_u64(),task["goal"].as_str().map(str::to_string))){return Err("Duplicate assignment".into())}
            let targets=task["targets"].as_array().filter(|a|!a.is_empty()&&a.len()<=8).ok_or("Invalid target scope")?;
            if !targets.contains(&task["target"])||!targets.iter().all(|n|n.as_u64().map(|n|n>0&&n<=context["catalog"]["targetIds"].as_array().unwrap().len() as u64&&(j.target==0||n==j.target as u64)).unwrap_or(false)){return Err("Invalid target scope".into())}
            scopes[id.to_string()]=task["targets"].clone();task.as_object_mut().unwrap().remove("targets");
            task["agentId"]=json!(id);
        }
        plan_chat_operation(ctx,SESSION.into(),operation.clone(),json!(assignments).to_string())?;
        let mut op=ctx.db.backend_chat().id().find(&operation).map(|op|hydrate_operation(ctx,op)).unwrap();let mut config:Value=serde_json::from_str(&op.config).unwrap();
        config["completionConditions"]=json!(assignments.iter().map(|t|json!({"agentId":t["agentId"],"goal":t["goal"],"targets":scopes[t["agentId"].as_u64().unwrap().to_string()],"required":1})).collect::<Vec<_>>());
        config["replans"]=json!(0);config["objective"]=json!(answer);op.config=config.to_string();store_operation(ctx,op);
        ctx.db.hosted_budget().insert(HostedBudget{operation:operation.clone(),calls:1});
        let mut records=vec![metric(ctx,j,None)];
        for task in &assignments {
            let agent=task["agentId"].as_u64().unwrap() as u32;let target=task["target"].as_u64().unwrap() as u32;
            records.push(json!({"type":"worker","agentId":agent,"target":target,"state":"queued","at":now(ctx)}));
            insert_job(ctx,Job{id:format!("{}:{}:1",operation,agent),operation:operation.clone(),turn:j.turn.clone(),identity:j.identity,role:j.role.clone(),epoch:j.epoch,generation:j.generation,agent,target,step:1,deadline:j.deadline+45000,state:"queued".into(),policy:0,request:String::new(),result:String::new(),started:0,finished:0});
        }
        update_chat_operation(ctx,SESSION.into(),operation.clone(),"running".into(),json!(records).to_string())?;
    }else if !["answer","clarify"].contains(&intent)||!tasks.is_empty(){return Err("provider_malformed_output".into())}
    update_chat_turn(ctx,SESSION.into(),j.turn.clone(),"completed".into(),json!({"intent":intent,"operationId":if operation.is_empty(){Value::Null}else{json!(operation)},"metric":metric(ctx,j,None)}).to_string(),if operation.is_empty(){format!("{}{}",answer,if ids.is_empty(){String::new()}else{format!(" Evidence: {}.",ids.iter().map(|n|format!("#{}",n)).collect::<Vec<_>>().join(", "))})}else{format!("{}\nAgents deployed within the original deadline; outcomes require simulation evidence.",answer)})
}
fn validate_explanation(v:&Value,input:&Value)->Result<(),String>{
 if v["explanation"].as_str().map(|s|s.trim().is_empty()||s.len()>300).unwrap_or(true){return Err("provider_malformed_output".into())}
 let ids=v["evidenceIds"].as_array().filter(|a|a.len()<=16).ok_or("provider_malformed_output")?;
 if !ids.iter().all(|id|id.as_u64().map(|n|n>0).unwrap_or(false)&&input["evidence"].as_array().into_iter().flatten().any(|e|e["id"]==*id)){return Err("Invalid evidence reference".into())}Ok(())
}
fn commit_action(ctx:&ReducerContext,j:&Job,v:&Value)->Result<(),String>{
    let kind=v["kind"].as_str().ok_or("provider_malformed_output")?;
    let request:Value=serde_json::from_str(&j.request).map_err(|_|"Invalid reservation")?;
    let input:Value=serde_json::from_str(request["messages"][1]["content"].as_str().ok_or("Invalid reservation")?).map_err(|_|"Invalid reservation")?;
    let allowed=&request["response_format"]["json_schema"]["schema"]["properties"]["kind"]["enum"];
    if v.as_object().map(|o|o.len())!=Some(5)||!allowed.as_array().unwrap().iter().any(|k|k==kind){return Err("provider_malformed_output".into())}
    validate_explanation(v,&input)?;
    let target=v["target"].as_u64().filter(|n|*n>0&&*n<=u32::MAX as u64).ok_or("Invalid target")? as u32;
    let recipient=v["recipientAgentId"].as_u64().ok_or("Invalid recipient")?;
    if kind!="handoff"&&recipient!=0{return Err("Invalid recipient".into())}
    let mut op=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
    let mut config:Value=serde_json::from_str(&op.config).map_err(|_|"Invalid operation")?;
    let mut rows=records(ctx,&j.operation);
    let control=["wait","retarget","handoff","help","finish"].contains(&kind);
    if !control&&target!=j.target{return Err("Outside assignment".into())}
    if ["wait","help","finish"].contains(&kind)&&target!=j.target{return Err("Outside assignment".into())}
    if kind=="retarget" {
        let valid=choices(ctx,j,&config,&rows).iter().any(|c|c["target"]==target&&!c["options"]["actions"].as_array().unwrap().is_empty());
        if target==j.target||!valid||v["evidenceIds"].as_array().unwrap().is_empty(){return Err("Invalid reassignment or missing evidence".into())}
        let task=config["tasks"].as_array_mut().unwrap().iter_mut().find(|t|t["agentId"]==j.agent).unwrap();task["target"]=json!(target);task["objective"]=json!(format!("{} DR-{:03}",task_goal(task,&j.role),target));
    }
    if kind=="handoff" {
        let recipient=config["tasks"].as_array().unwrap().iter().find(|t|t["agentId"]==recipient&&recipient!=j.agent as u64).ok_or("Handoff outside team")?;
        if !scope(&config,recipient["agentId"].as_u64().unwrap() as u32).contains(&target)||v["evidenceIds"].as_array().unwrap().is_empty(){return Err("Handoff outside scope or missing evidence".into())}
        if !input["evidence"].as_array().unwrap().iter().any(|e|e["target"]==target&&v["evidenceIds"].as_array().unwrap().contains(&e["id"])){return Err("Handoff requires target evidence".into())}
        if latest_worker(&rows,&recipient["agentId"]).map(|w|!worker_active(w["state"].as_str().unwrap_or(""))).unwrap_or(false){return Err("Handoff recipient is terminal".into())}
        if v["evidenceIds"].as_array().unwrap().iter().all(|id|rows.iter().any(|r|r["type"]=="handoff"&&r["agentId"]==j.agent&&r["recipientAgentId"]==recipient["agentId"]&&r["evidenceIds"].as_array().map(|ids|ids.contains(id)).unwrap_or(false))){return Err("Evidence already handed off".into())}
        rows.push(json!({"type":"handoff","agentId":j.agent,"recipientAgentId":recipient["agentId"],"target":target,"evidenceIds":v["evidenceIds"],"explanation":v["explanation"],"at":now(ctx)}));
    }
    // A changed policy invalidates this decision, not the mission or a simulated attack.
    if !control&&(fleet::hosted_policy(ctx,j.target)?!=j.policy||fleet::battle_target_pending(ctx,&j.role,j.target,j.agent)) {
        fleet::execute_fleet_chat_action(ctx,SESSION.into(),j.operation.clone(),j.step,j.agent,j.target,"wait".into(),j.policy)?;
        rows.push(metric(ctx,j,None));rows.push(json!({"type":"decision","agentId":j.agent,"target":j.target,"kind":kind,"status":"deferred","reason":"Policy or teammate execution changed during inference; fresh observation required.","explanation":v["explanation"],"evidenceIds":v["evidenceIds"],"at":now(ctx)}));op.result=json!(rows).to_string();store_operation(ctx,op);
        next_job(ctx,j,"observing","Policy changed; observing before another decision.",0);return Ok(())
    }
    fleet::execute_fleet_chat_action(ctx,SESSION.into(),j.operation.clone(),j.step,j.agent,j.target,if control{"wait"}else{kind}.into(),j.policy)?;
    rows.push(metric(ctx,j,None));op.config=config.to_string();op.result=json!(rows).to_string();store_operation(ctx,op);
    let mut receipt=fleet::hosted_receipt(ctx,&j.id);
    if kind=="retarget"{receipt["newTarget"]=json!(target);}
    if kind=="handoff"{receipt["recipientAgentId"]=json!(recipient);}
    receipt["explanation"]=v["explanation"].clone();receipt["evidenceIds"]=v["evidenceIds"].clone();
    receipt["stateKey"]=json!(state_key(&json!({"observations":input["observations"],"battle":input["battle"],"options":input["options"],"choices":input["targetChoices"]})));
    if kind=="wait" {
        let repeated=rows_of_kind(ctx,j,"wait").iter().rev().take(2).filter(|r|r["stateKey"]==receipt["stateKey"]).count()>=2;
        if repeated{receipt["blocked"]=json!("Repeated waits against unchanged state.");}
    }
    if ["finish","help"].contains(&kind){receipt["blocked"]=v["explanation"].clone();}
    complete_action(ctx,j,kind,receipt)?;
    Ok(())
}
fn state_key(value:&Value)->String {
 let mut hash=14695981039346656037u64;for byte in value.to_string().bytes(){hash=(hash^byte as u64).wrapping_mul(1099511628211);}format!("{:016x}",hash)
}
fn rows_of_kind(ctx:&ReducerContext,j:&Job,kind:&str)->Vec<Value>{records(ctx,&j.operation).into_iter().filter(|r|r["agentId"]==j.agent&&r["kind"]==kind).collect()}
fn next_job(ctx:&ReducerContext,j:&Job,state:&str,reason:&str,delay:i64){
    if j.step>=8{close_worker(ctx,j,"exhausted","Decision budget exhausted.");return}
    let mut next=j.clone();next.step+=1;next.id=format!("{}:{}:{}",j.operation,j.agent,next.step);
    next.target=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)).and_then(|r|serde_json::from_str::<Value>(&r.config).ok()).and_then(|v|v["tasks"].as_array().and_then(|ts|ts.iter().find(|t|t["agentId"]==j.agent)).and_then(|t|t["target"].as_u64())).unwrap_or(j.target as u64) as u32;
    next.state=if delay>0{"waiting"}else{"queued"}.into();next.started=0;next.finished=0;next.request.clear();next.result=json!({"wakeAt":now(ctx)+delay}).to_string();
    worker_state(ctx,&next,state,reason);alarm(ctx,&next.id,now(ctx)+delay,false);alarm(ctx,&next.id,next.deadline,true);ctx.db.hosted_job().insert(next);
}
fn complete_action(ctx:&ReducerContext,j:&Job,kind:&str,mut receipt:Value)->Result<(),String>{
    if receipt.is_null(){return Err("Attempt receipt missing".into())}
    let pending=receipt["stage"].as_str().map(|s|s!="resolved").unwrap_or(false);
    receipt["agentId"]=json!(j.agent);receipt["target"]=json!(j.target);receipt["step"]=json!(j.step);receipt["kind"]=json!(kind);receipt["status"]=json!(if pending{"queued"}else{"executed"});receipt["actionId"]=json!(j.id);receipt["at"]=json!(now(ctx));
    let mut op=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
    let config:Value=serde_json::from_str(&op.config).map_err(|_|"Invalid operation")?;
    let task=config["tasks"].as_array().unwrap().iter().find(|t|t["agentId"]==j.agent).ok_or("Assignment missing")?;
    let goal=task_goal(task,&j.role);
    let satisfied=!pending&&kind!="retarget"&&fleet::battle_goal_done(ctx,goal,j.target,&receipt);
    let mut rows:Vec<Value>=serde_json::from_str(&op.result).map_err(|_|"Invalid results")?;
    // Preserve the decision's explanation when replacing its queued receipt with a resolved one.
    if let Some(old)=rows.iter_mut().find(|v|v["actionId"]==j.id){
        for key in ["explanation","evidenceIds","stateKey","blocked"]{if receipt[key].is_null()&&!old[key].is_null(){receipt[key]=old[key].clone();}}
        *old=receipt.clone();
    }else{rows.push(receipt.clone())}
    let terminal=if satisfied{Some(("completed","Objective verified by simulation state."))}
        else if j.step>=8{Some(("exhausted","Decision budget exhausted."))}
        else if receipt["blocked"].is_string(){Some(("blocked",receipt["blocked"].as_str().unwrap()))}else{None};
    op.result=json!(rows).to_string();store_operation(ctx,op);
    let mut saved=ctx.db.hosted_job().id().find(&j.id).ok_or("Job missing")?;
    saved.state=if pending{"attempt"}else{"done"}.into();if !pending{saved.finished=now(ctx);saved.request.clear();}ctx.db.hosted_job().id().update(saved);
    if pending{worker_state(ctx,j,"executing","Waiting for the authoritative simulated attempt result.");alarm(ctx,&j.id,now(ctx)+500,false);}
    else if let Some((state,reason))=terminal{close_worker(ctx,j,state,reason);}
    else{next_job(ctx,j,if kind=="wait"{"waiting"}else{"observing"},if kind=="wait"{"Scheduled pause; fresh observation follows."}else{"Observing the latest result before choosing another action."},if kind=="wait"{1500}else{0});}
    Ok(())
}
pub(super) fn clear_jobs(ctx:&ReducerContext){
 // HTTP already sent cannot be cancelled: retain its slot and watchdog until it returns.
 let inflight:std::collections::HashSet<_>=ctx.db.hosted_job().state().filter("running").map(|j|j.id).collect();
 for a in ctx.db.hosted_alarm().iter(){if !a.watchdog||!inflight.contains(&a.job){ctx.db.hosted_alarm().id().delete(a.id);}}
 for mut j in ctx.db.hosted_job().state().filter("queued").chain(ctx.db.hosted_job().state().filter("waiting")).chain(ctx.db.hosted_job().state().filter("attempt")){j.state="cancelled".into();j.finished=now(ctx);j.request.clear();ctx.db.hosted_job().id().update(j);}
 assert!(inflight.iter().all(|id|ctx.db.hosted_job().id().find(id.clone()).map(|j|j.state)==Some("running".into())),"Reset must retain outstanding inference reservations");
}

fn mission_conditions(ctx:&ReducerContext,config:&Value,role:&str,rows:&[Value])->Vec<Value>{
 config["tasks"].as_array().into_iter().flatten().map(|t|{
  let receipt=rows.iter().rev().find(|r|r["agentId"]==t["agentId"]&&r["actionId"].is_string()).unwrap_or(&Value::Null);
  let contract=config["completionConditions"].as_array().and_then(|cs|cs.iter().find(|c|c["agentId"]==t["agentId"])).unwrap_or(t);
  let targets=scope(config,t["agentId"].as_u64().unwrap() as u32);let target=t["target"].as_u64().unwrap() as u32;
  let verified=task_goal(contract,role)==task_goal(t,role)&&targets.contains(&target)&&latest_worker(rows,&t["agentId"]).map(|w|w["state"]=="completed").unwrap_or(false)&&fleet::battle_goal_done(ctx,task_goal(contract,role),target,receipt);
  json!({"agentId":t["agentId"],"target":target,"goal":task_goal(contract,role),"acceptedTargets":targets,"verified":verified})
 }).collect()
}
fn mission_outcome(config:&Value,rows:&[Value])->(&'static str,&'static str,usize,usize){
 let workers:Vec<_>=config["tasks"].as_array().into_iter().flatten().filter_map(|t|latest_worker(rows,&t["agentId"])).collect();
 let completed=workers.iter().filter(|w|w["state"]=="completed").count();
 let partial=completed>0||rows.iter().any(|r|r["simulation"]["succeeded"].as_u64().unwrap_or(0)>0||r["simulation"]["partial"].as_u64().unwrap_or(0)>0);
 let (state,outcome)=if workers.iter().any(|w|w["state"]=="failed")||rows.iter().any(|r|r["type"]=="replan"&&r["state"]=="failed"){("failed","execution_failure")}
 else if completed==workers.len()&&!workers.is_empty(){("completed","verified_success")}
 else if workers.iter().any(|w|w["state"]=="exhausted"){("exhausted",if workers.iter().any(|w|w["error"]=="operation_timeout"){"deadline_exhausted"}else{"budget_exhausted"})}
 else if partial{("partial","partial_completion")}else{("blocked","blocked")};
 (state,outcome,completed,workers.len())
}
fn finish_operation(ctx:&ReducerContext,id:&str){
 let Some(r)=ctx.db.backend_chat().id().find(id.to_string()).map(|op|hydrate_operation(ctx,op))else{return};if r.state!="running"{return}
 let mut config:Value=serde_json::from_str(&r.config).unwrap();let mut rows:Vec<Value>=serde_json::from_str(&r.result).unwrap();
 if !config["tasks"].as_array().unwrap().iter().all(|t|latest_worker(&rows,&t["agentId"]).map(|w|!worker_active(w["state"].as_str().unwrap_or(""))).unwrap_or(false)){return}
 for task in config["tasks"].as_array().unwrap(){
  if latest_worker(&rows,&task["agentId"]).map(|w|w["state"]=="completed").unwrap_or(false){
   let last=rows.iter().rev().find(|r|r["agentId"]==task["agentId"]&&r["actionId"].is_string()).unwrap_or(&Value::Null);
   if !fleet::battle_goal_done(ctx,task_goal(task,&r.role),task["target"].as_u64().unwrap() as u32,last){
    rows.push(json!({"type":"worker","agentId":task["agentId"],"target":task["target"],"state":"blocked","reason":"The previously verified condition changed before mission completion.","at":now(ctx)}));
   }
  }
 }
 let mut saved=r.clone();saved.result=json!(rows).to_string();store_operation(ctx,saved);
 if ctx.db.hosted_job().operation().filter(id).any(|j|j.agent==0&&["queued","running"].contains(&j.state.as_str())&&serde_json::from_str::<Value>(&j.result).ok().and_then(|v|v["error"].as_str().map(str::to_string)).is_none()){return}
 let replans=config["replans"].as_u64().unwrap_or(0);
 let calls=ctx.db.hosted_budget().operation().find(id.to_string()).map(|b|b.calls).unwrap_or(33);
 let deadline=config["deadline"].as_i64().unwrap_or(0);
 let candidate=ctx.db.hosted_job().operation().filter(id).filter(|j|j.agent>0&&j.step<8&&latest_worker(&rows,&json!(j.agent)).map(|w|w["state"]=="blocked").unwrap_or(false)).max_by_key(|j|j.step);
 if let Some(mut j)=candidate {
  let useful=config["tasks"].as_array().unwrap().iter().filter(|t|latest_worker(&rows,&t["agentId"]).map(|w|w["state"]=="blocked").unwrap_or(false)).any(|t|{
    let mut worker=j.clone();worker.agent=t["agentId"].as_u64().unwrap() as u32;
    choices(ctx,&worker,&config,&rows).iter().any(|c|!c["options"]["actions"].as_array().unwrap().is_empty())
  });
  if useful&&replans<2&&calls<33&&now(ctx)<deadline&&!rows.iter().any(|r|r["type"]=="replan"&&r["state"]=="failed") {
   config["replans"]=json!(replans+1);let mut op=r.clone();op.config=config.to_string();op.result=json!(rows).to_string();store_operation(ctx,op);
   j.id=format!("{}:replan:{}",id,replans+1);j.agent=0;j.target=0;j.step=0;j.state="queued".into();j.request.clear();j.result.clear();j.started=0;j.finished=0;
   insert_job(ctx,j);
   let _=append_chat_message(ctx,r.generation,format!("{}:replan:{}:queued",id,replans+1),&r.role,id,"coordinator","Assignments reached a blocker. Reassessing within the remaining mission budget.".into(),0);
   return
  }
 }
 let (mut state,mut outcome,completed,total)=mission_outcome(&config,&rows);
 if state!="completed"&&state!="failed"{if now(ctx)>=deadline{state="exhausted";outcome="deadline_exhausted";}else if calls>=33{state="exhausted";outcome="budget_exhausted";}}
 let conditions=mission_conditions(ctx,&config,&r.role,&rows);
 rows.push(json!({"type":"mission","outcome":outcome,"completed":completed,"total":total,"conditions":conditions,"at":now(ctx)}));
 let _=update_chat_operation(ctx,SESSION.into(),id.into(),state.into(),json!(rows).to_string());
}
fn commit_replan(ctx:&ReducerContext,j:&Job,v:&Value)->Result<(),String>{
 let mut op=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
 let mut config:Value=serde_json::from_str(&op.config).map_err(|_|"Invalid operation")?;
 if v.as_object().map(|o|o.len())!=Some(3){return Err("provider_malformed_output".into())}
 let request:Value=serde_json::from_str(&j.request).map_err(|_|"Invalid reservation")?;
 let input:Value=serde_json::from_str(request["messages"][1]["content"].as_str().ok_or("Invalid reservation")?).map_err(|_|"Invalid reservation")?;
 validate_explanation(v,&input)?;
 let assignments=v["assignments"].as_array().filter(|a|a.len()<=4).ok_or("Invalid replan")?;
 let mut rows=records(ctx,&j.operation);let mut used=std::collections::HashSet::new();let mut resumed=vec![];
 for a in assignments {
  if a.as_object().map(|o|o.len())!=Some(2){return Err("Invalid replan".into())}
  let agent=a["agentId"].as_u64().filter(|n|*n<=u32::MAX as u64).ok_or("Invalid agent")? as u32;
  let target=a["target"].as_u64().filter(|n|*n<=u32::MAX as u64).ok_or("Invalid target")? as u32;
  if !used.insert(agent)||!latest_worker(&rows,&json!(agent)).map(|w|w["state"]=="blocked").unwrap_or(false){return Err("Replan requires a blocked teammate".into())}
  let previous=ctx.db.hosted_job().operation().filter(j.operation.as_str()).filter(|p|p.agent==agent).max_by_key(|p|p.step).ok_or("Worker missing")?;
  if previous.step>=8||!choices(ctx,&previous,&config,&rows).iter().any(|c|c["target"]==target&&!c["options"]["actions"].as_array().unwrap().is_empty()){return Err("Replan outside scope or budget".into())}
  let task=config["tasks"].as_array_mut().unwrap().iter_mut().find(|t|t["agentId"]==agent).unwrap();task["target"]=json!(target);task["objective"]=json!(format!("{} DR-{:03}",task_goal(task,&j.role),target));
  rows.push(json!({"type":"worker","agentId":agent,"target":target,"state":"observing","reason":"Coordinator revised the assignment using mission evidence.","at":now(ctx)}));resumed.push(previous);
 }
 rows.push(metric(ctx,j,None));rows.push(json!({"type":"replan","state":"completed","explanation":v["explanation"],"evidenceIds":v["evidenceIds"],"assignments":assignments,"at":now(ctx)}));
 op.config=config.to_string();op.result=json!(rows).to_string();store_operation(ctx,op);
 for previous in resumed{next_job(ctx,&previous,"observing","Coordinator revised the assignment using mission evidence.",0);}
 let mut saved=ctx.db.hosted_job().id().find(&j.id).unwrap();saved.state="done".into();saved.finished=now(ctx);ctx.db.hosted_job().id().update(saved);
 let _=append_chat_message(ctx,j.generation,format!("{}:reply",j.id),&j.role,&j.operation,"coordinator",format!("Plan adjustment: {}",v["explanation"].as_str().unwrap()),0);
 // Empty/declined replans are terminal, without asking the provider the same question again.
 if assignments.is_empty(){let mut op=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)).unwrap();config["replans"]=json!(2);op.config=config.to_string();store_operation(ctx,op);}
 finish_operation(ctx,&j.operation);Ok(())
}
#[view(accessor=visible_chat_operations,public)]
pub fn visible_chat_operations(ctx:&ViewContext)->Vec<OperationRow>{
 let r=fleet::view_role(ctx);let g=visible_conversation_generation(ctx,&r);if ctx.db.fleet_session().id().find(0).is_none(){return vec![]}
 ctx.db.backend_chat().conversation().filter((r.as_str(),g)).map(|op|view_operation(ctx,op).into()).collect()
}
#[view(accessor=visible_chat_messages,public)]
pub fn visible_chat_messages(ctx:&ViewContext)->Vec<MessageRow>{
 let r=fleet::view_role(ctx);let g=visible_conversation_generation(ctx,&r);if ctx.db.fleet_session().id().find(0).is_none(){return vec![]}
 ctx.db.backend_chat_message().conversation().filter((r.as_str(),g)).map(Into::into).collect()
}
#[view(accessor=visible_chat_turns,public)]
pub fn visible_chat_turns(ctx:&ViewContext)->Vec<TurnRow>{
 let r=fleet::view_role(ctx);let g=visible_conversation_generation(ctx,&r);if ctx.db.fleet_session().id().find(0).is_none(){return vec![]}
 ctx.db.backend_chat_turn().conversation().filter((r.as_str(),g)).map(Into::into).collect()
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn conversation_schema_allows_read_only_answers(){assert_eq!(tasks_schema(200)["minItems"],0);}
 #[test] fn provider_metadata_keeps_only_reported_accounting(){
  assert_eq!(provider_metadata(r#"{"model":"actual-model","usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16,"secret":"no"},"choices":[{"finish_reason":"stop","message":{"content":"private"}}]}"#),json!({"reportedModel":"actual-model","finishReason":"stop","usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}));
  assert_eq!(provider_metadata("broken"),Value::Null);
  assert_eq!(provider_metadata("{}"),json!({"reportedModel":null,"finishReason":null,"usage":null}));
 }
 #[test] fn provider_errors_are_truthful(){
  assert_eq!(parse_provider(r#"{"choices":[{"finish_reason":"stop","message":{"refusal":"no"}}]}"#).unwrap_err(),"provider_refused");
  assert_eq!(parse_provider(r#"{"choices":[{"finish_reason":"length","message":{"content":"{}"}}]}"#).unwrap_err(),"provider_truncated_output");
  assert!(parse_provider("broken").is_err());
  assert_eq!(parse_provider(r#"{"choices":[{"finish_reason":"stop","message":{"content":"{\"kind\":\"wait\"}"}}]}"#).unwrap(),json!({"kind":"wait"}));
 }
}

pub(super) fn battle_authorized(ctx:&ReducerContext,operation:&str,agent:u32,target:u32)->bool {
 let jobs:Vec<_>=ctx.db.hosted_job().operation().filter(operation).collect();
 if jobs.is_empty(){return true}
 let Some(j)=jobs.iter().filter(|j|j.agent==agent).max_by_key(|j|j.step)else{return false};
 current(ctx,j).is_ok()&&ctx.db.backend_chat().id().find(operation.to_string()).map(|op|hydrate_operation(ctx,op)).and_then(|r|serde_json::from_str::<Value>(&r.config).ok()).map(|v|v["tasks"].as_array().into_iter().flatten().any(|t|t["agentId"]==agent&&t["target"]==target)).unwrap_or(false)
}

fn cleanup_agent(ctx:&ReducerContext,operation:&str,agent:u32){
 for job in ctx.db.hosted_job().operation().filter(operation).filter(|j|j.agent==agent&&j.state!="running"){
  for a in ctx.db.hosted_alarm().job().filter(job.id.as_str()){ctx.db.hosted_alarm().id().delete(a.id);}
 }
}
fn worker_state(ctx:&ReducerContext,j:&Job,state:&str,reason:&str){
 if let Some(mut op)=ctx.db.backend_chat().id().find(&j.operation).map(|op|hydrate_operation(ctx,op)){let mut rows:Vec<Value>=serde_json::from_str(&op.result).unwrap_or_default();if rows.iter().rev().find(|r|r["type"]=="worker"&&r["agentId"]==j.agent).map(|r|r["state"]==state&&r["reason"]==reason).unwrap_or(false){return}rows.push(json!({"type":"worker","agentId":j.agent,"target":j.target,"state":state,"reason":reason,"at":now(ctx)}));op.result=json!(rows).to_string();store_operation(ctx,op);}
}
fn close_worker(ctx:&ReducerContext,j:&Job,state:&str,reason:&str){
 worker_state(ctx,j,state,reason);
 if let Some(mut saved)=ctx.db.hosted_job().id().find(&j.id){saved.state="done".into();saved.finished=now(ctx);ctx.db.hosted_job().id().update(saved);}
 cleanup_agent(ctx,&j.operation,j.agent);finish_operation(ctx,&j.operation);
}
pub(super) fn cleanup_operation(ctx:&ReducerContext,id:&str){
 for mut job in ctx.db.hosted_job().operation().filter(id){
  for a in ctx.db.hosted_alarm().job().filter(job.id.as_str()){if !(job.state=="running"&&a.watchdog){ctx.db.hosted_alarm().id().delete(a.id);}}
  if ["queued","waiting","attempt"].contains(&job.state.as_str()){job.state="cancelled".into();job.finished=now(ctx);job.request.clear();ctx.db.hosted_job().id().update(job);}
 }
}
pub(super) fn view_job(ctx:&ViewContext,id:&str)->Value{ctx.db.hosted_job().id().find(id.to_string()).map(|j|json!({"state":j.state,"started":j.started,"finished":j.finished})).unwrap_or(Value::Null)}

pub(super) fn expire_operation(ctx:&ReducerContext,id:&str)->bool {
 let jobs:Vec<_>=ctx.db.hosted_job().operation().filter(id).collect();if jobs.is_empty(){return false}
 for j in &jobs {
  if ["queued","waiting","running","attempt"].contains(&j.state.as_str()){fail(ctx,j,"operation_timeout");}
 }
 finish_operation(ctx,id);true
}

// Only the separately built local fixture module exposes these owner-only test seams.
#[cfg(feature="mission-fixtures")]
#[reducer]
pub fn fixture_hosted_reserve(ctx:&ReducerContext,id:String)->Result<(),String>{
 owner(ctx)?;
 let j=ctx.db.hosted_job().id().find(&id).ok_or("Job missing")?;
 if j.state=="attempt"{current(ctx,&j)?;let kind=serde_json::from_str::<Value>(&j.result).unwrap()["kind"].as_str().unwrap().to_string();complete_action(ctx,&j,&kind,fleet::hosted_receipt(ctx,&id))?;}
 else{reserve(ctx,&id)?;}Ok(())
}
#[cfg(feature="mission-fixtures")]
#[reducer]
pub fn fixture_hosted_reply(ctx:&ReducerContext,id:String,reply:String,error:String)->Result<(),String>{
 owner(ctx)?;let j=ctx.db.hosted_job().id().find(&id).ok_or("Job missing")?;
 if error.is_empty(){apply_inference(ctx,&j,&Ok(serde_json::from_str(&reply).map_err(|_|"Invalid fixture")?))?;}
 else {fail(ctx,&j,&error);}
 if let Some(mut saved)=ctx.db.hosted_job().id().find(&id){if saved.state=="running"{saved.state="failed".into();saved.finished=now(ctx);saved.request.clear();ctx.db.hosted_job().id().update(saved);}}
 Ok(())
}

#[cfg(feature="mission-fixtures")]
#[reducer]
pub fn fixture_hosted_limits(ctx:&ReducerContext,operation:String,calls:u32,remaining_ms:u32)->Result<(),String>{
 owner(ctx)?;
 let mut op=ctx.db.backend_chat().id().find(&operation).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
 let mut config:Value=serde_json::from_str(&op.config).unwrap();
 let mut budget=ctx.db.hosted_budget().operation().find(&operation).ok_or("Budget missing")?;
 let deadline=now(ctx)+remaining_ms as i64;
 if calls<budget.calls||calls>33||deadline>config["deadline"].as_i64().unwrap(){return Err("Fixtures may only reduce remaining budgets".into())}
 budget.calls=calls;ctx.db.hosted_budget().operation().update(budget);
 config["deadline"]=json!(deadline);op.config=config.to_string();store_operation(ctx,op);
 for mut j in ctx.db.hosted_job().operation().filter(operation.as_str()){j.deadline=deadline;ctx.db.hosted_job().id().update(j);}
 Ok(())
}
