//! Hosted chat orchestration. Only fixed Bitdeer egress; all decisions pass the existing reducers.
use super::*;
use crate::fleet;
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
    operation: String,
    turn: String,
    identity: Identity,
    role: String,
    epoch: u64,
    generation: u64,
    agent: u32,
    target: u32,
    step: u32,
    deadline: i64,
    state: String,
    policy: u32,
    request: String,
    result: String,
    started: i64,
    finished: i64,
}
#[table(accessor=hosted_budget)]
pub struct HostedBudget { #[primary_key] operation:String, calls:u32 }
#[table(accessor=hosted_alarm,scheduled(hosted_infer))]
pub struct Alarm { #[primary_key] #[auto_inc] id:u64, scheduled_at:ScheduleAt, job:String, watchdog:bool }
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
    if j.agent==0 {
        if ctx.db.backend_chat_turn().id().find(&j.turn).map(|t|t.state)!=Some("running".into()){return Err("cancelled".into())}
    } else if ctx.db.backend_chat().id().find(&j.operation).map(|r|r.state)!=Some("running".into()){return Err("cancelled".into())}
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
    if ctx.db.backend_chat_turn().role().filter(role.as_str()).any(|t|["queued","running"].contains(&t.state.as_str())) {
        if !["stop","cancel","pause"].contains(&message.trim().to_ascii_lowercase().as_str()){return Err("Conversation already pending".into())}
    }
    let id=ctx.new_uuid_v4().map_err(|_|"Identity generation failed")?.to_string();
    let config=json!({"epoch":epoch,"conversation":generation,"message":message,"target":if target==0{Value::Null}else{json!(target)},"createdAt":now(ctx),"deadline":now(ctx)+30000});
    append_chat_message(ctx,generation,format!("{}:user",request_key),&role,"","operator",message.clone(),target)?;
    if ["stop","cancel","pause"].contains(&message.trim().to_ascii_lowercase().as_str()) {
        cancel_role(ctx,&role);
        append_chat_message(ctx,generation,format!("{}:reply",id),&role,"","coordinator","Stopped your pending work. In-flight results cannot apply.".into(),0)?;
        ctx.db.backend_chat_turn().insert(ChatTurn{id,request_key,role,state:"completed".into(),config:config.to_string(),result:json!({"intent":"answer"}).to_string(),created:now(ctx),updated:now(ctx)});
        return Ok(())
    }
    append_chat_message(ctx,generation,format!("{}:accepted",id),&role,"","coordinator","Planning…".into(),target)?;
    ctx.db.backend_chat_turn().insert(ChatTurn{id:id.clone(),request_key,role:role.clone(),state:"running".into(),config:config.to_string(),result:"{}".into(),created:now(ctx),updated:now(ctx)});
    insert_job(ctx,Job{id:id.clone(),operation:String::new(),turn:id,identity:ctx.sender(),role,epoch,generation,agent:0,target,step:0,deadline:now(ctx)+30000,state:"queued".into(),policy:0,request:String::new(),result:String::new(),started:0,finished:0});
    Ok(())
}
fn cancel_role(ctx:&ReducerContext,role:&str) {
    for mut t in ctx.db.backend_chat_turn().role().filter(role).filter(|t|["queued","running"].contains(&t.state.as_str())) {t.state="cancelled".into();t.updated=now(ctx);ctx.db.backend_chat_turn().id().update(t);}
    for mut r in ctx.db.backend_chat().iter().filter(|r|r.role==role&&["planning","running"].contains(&r.state.as_str())) {r.state="cancelled".into();chat_transition(ctx,&r.id,"cancelled");ctx.db.backend_chat().id().update(r);}
}
#[reducer]
pub fn new_maincloud_chat(ctx:&ReducerContext,epoch:u64,generation:u64)->Result<(),String>{
    let r=role(ctx)?;check_chat_epoch(ctx,epoch)?;check_conversation(ctx,&r,generation)?;
    cancel_role(ctx,&r);clear_conversation(ctx,&r);Ok(())
}
#[reducer]
pub fn reset_maincloud_fleet(ctx:&ReducerContext,epoch:u64,demo:bool)->Result<(),String>{
    fleet::hosted_reset(ctx,epoch,demo)?;
    clear_conversation(ctx,"attacker");clear_conversation(ctx,"defender");Ok(())
}
fn insert_job(ctx:&ReducerContext,j:Job){
    alarm(ctx,&j.id,now(ctx),false);alarm(ctx,&j.id,j.deadline,true);ctx.db.hosted_job().insert(j);
}
fn tasks_schema(max:u64)->Value {json!({"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":false,"required":["name","specialty","target","objective"],"properties":{"name":{"type":"string"},"specialty":{"type":"string"},"target":{"type":"integer","minimum":1,"maximum":max},"objective":{"type":"string"}}}})}
fn prompt(ctx:&ReducerContext,j:&Job)->Result<Value,String> {
    let prompts:Value=serde_json::from_str(include_str!("../../shared/fleet-prompts.json")).unwrap();
    let mut input=fleet::hosted_context(ctx,&j.role,j.target);
    let max=fleet::hosted_context(ctx,&j.role,0)["catalog"]["targetIds"].as_array().ok_or("Fleet missing")?.len() as u64;
    let (system,schema)=if j.agent==0 {
        let t=ctx.db.backend_chat_turn().id().find(&j.turn).ok_or("Turn missing")?;
        let v:Value=serde_json::from_str(&t.config).map_err(|_|"Invalid turn")?;
        input["message"]=v["message"].clone(); input["selectedTarget"]=v["target"].clone();
        let mut history:Vec<_>=ctx.db.backend_chat_message().role().filter(j.role.as_str()).filter(|m|m.key.starts_with(&format!("epoch:{}:chat:{}:",j.epoch,j.generation))&&!m.key.ends_with(":accepted")).collect();
        history.sort_by_key(|m|m.id);
        input["history"]=json!(history.iter().rev().take(12).map(|m|json!({"speaker":m.speaker,"text":m.text.chars().take(700).collect::<String>(),"target":m.target})).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>());
        input["operations"]=json!(ctx.db.backend_chat().iter().filter(|r|r.epoch==j.epoch&&r.role==j.role&&config_generation(&r.config)==j.generation).map(|r|json!({"id":r.id,"state":r.state,"config":serde_json::from_str::<Value>(&r.config).unwrap_or(Value::Null),"results":serde_json::from_str::<Vec<Value>>(&r.result).unwrap_or_default().into_iter().rev().take(8).collect::<Vec<_>>()})).collect::<Vec<_>>().into_iter().rev().take(2).collect::<Vec<_>>());
        (prompts["coordinator"].clone(),json!({"type":"object","additionalProperties":false,"required":["intent","answer","evidenceIds","tasks"],"properties":{"intent":{"type":"string","enum":["answer","clarify","deploy","replace"]},"answer":{"type":"string"},"evidenceIds":{"type":"array","items":{"type":"integer"}},"tasks":tasks_schema(max)}}))
    }else{
        let r=ctx.db.backend_chat().id().find(&j.operation).ok_or("Operation missing")?;
        let v:Value=serde_json::from_str(&r.config).map_err(|_|"Invalid operation")?;
        input["assignment"]=v["tasks"].as_array().unwrap().iter().find(|t|t["agentId"]==j.agent).cloned().ok_or("Assignment missing")?;
        input["memory"]=json!(serde_json::from_str::<Vec<Value>>(&r.result).unwrap_or_default().into_iter().filter(|r|r["agentId"]==j.agent&&r["type"]!="inference").collect::<Vec<_>>());
        input["decisionsRemaining"]=json!(9-j.step);
        let discovered=input["observations"].as_array().map(|a|!a.is_empty()).unwrap_or(false);
        let allowed=if j.role=="attacker"{if discovered{vec!["prepare","command","spread","wait"]}else{vec!["discover","wait"]}}else{vec!["prepare","isolate","harden","verify","release","wait"]};
        (prompts["specialist"].clone(),json!({"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"type":"string","enum":allowed}}}))
    };
    let model=if j.agent==0{ctx.env.BITDEER_COORDINATOR_MODEL()}else{ctx.env.BITDEER_SPECIALIST_MODEL()}.unwrap_or(MODEL.into());
    Ok(json!({"model":model,"temperature":0,"max_tokens":if j.agent==0{1536}else{512},"reasoning_effort":"low","response_format":{"type":"json_schema","json_schema":{"name":if j.agent==0{"fleet_plan"}else{"fleet_action"},"strict":true,"schema":schema}},"messages":[{"role":"system","content":json!({"task":system,"role":j.role,"agents":{"min":2,"max":4},"targets":{"min":1,"max":max},"allowed":schema["properties"]["kind"]["enum"]}).to_string()},{"role":"user","content":input.to_string()}]}))
}
fn reserve(ctx:&ReducerContext,id:&str)->Result<Option<Job>,String>{
    let Some(mut j)=ctx.db.hosted_job().id().find(id.to_string())else{return Ok(None)};
    if j.state!="queued"{return Ok(None)}
    current(ctx,&j)?;
    if ctx.db.hosted_job().iter().filter(|j|j.state=="running").count()>=4{alarm(ctx,id,now(ctx)+250,false);return Ok(None)}
    if j.agent>0 {
        let mut b=ctx.db.hosted_budget().operation().find(&j.operation).ok_or("Budget missing")?;
        if b.calls>=33{return Err("model_budget_exhausted".into())} b.calls+=1;ctx.db.hosted_budget().operation().update(b);
        j.policy=fleet::hosted_policy(ctx,j.target)?;
    }
    j.request=prompt(ctx,&j)?.to_string();j.state="running".into();j.started=now(ctx);
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
fn inference(ctx:&mut ProcedureContext,j:&Job)->Result<Value,String>{
    let key=ctx.env.BITDEER_API_KEY().filter(|k|!k.is_empty()).ok_or("provider_not_configured")?;
    let timeout=(j.deadline-j.started).clamp(1,20000) as u64;
    let request=spacetimedb::http::Request::builder().uri("https://api-inference.bitdeer.ai/v1/chat/completions").method("POST").header("Content-Type","application/json").header("Authorization",format!("Bearer {}",key)).extension(spacetimedb::http::Timeout::from(spacetimedb::TimeDuration::from(std::time::Duration::from_millis(timeout)))).body(j.request.clone()).map_err(|_|"provider_transport_error")?;
    let response=ctx.http.send(request).map_err(|e|if e.to_string().to_ascii_lowercase().contains("tim"){"provider_timeout"}else{"provider_transport_error"})?;
    if !response.status().is_success(){return Err(format!("{}: HTTP {}",if response.status().as_u16()==429{"provider_rate_limit"}else{"provider_http_error"},response.status().as_u16()))}
    parse_provider(&response.into_body().into_string_lossy())
}
#[procedure]
pub fn hosted_infer(ctx:&mut ProcedureContext,a:Alarm){
    if ctx.sender()!=ctx.database_identity()||ctx.connection_id().is_some(){return}
    let waiting=ctx.with_tx(|tx| {
        let Some(j)=tx.db.hosted_job().id().find(&a.job)else{return false};
        if j.state!="attempt"{return false}
        if let Err(e)=current(tx,&j){fail(tx,&j,&e);return true}
        let kind=serde_json::from_str::<Value>(&j.result).ok().and_then(|v|v["kind"].as_str().map(str::to_string)).unwrap_or_default();
        let receipt=fleet::hosted_receipt(tx,&j.id);
        if let Err(e)=complete_action(tx,&j,&kind,receipt){fail(tx,&j,&e);return true}
        if tx.db.hosted_job().id().find(&j.id).map(|j|j.state)==Some("attempt".into()){alarm(tx,&j.id,now(tx)+500,false);}
        true
    });
    if waiting{return}
    if a.watchdog {
        ctx.with_tx(|tx|{if let Some(j)=tx.db.hosted_job().id().find(&a.job){if ["queued","running","attempt"].contains(&j.state.as_str())&&now(tx)>=j.deadline{fail(tx,&j,"operation_timeout");}}});return
    }
    let reserved=ctx.try_with_tx(|tx|reserve(tx,&a.job));
    let j=match reserved {Ok(Some(j))=>j,Ok(None)=>return,Err(e)=>{ctx.with_tx(|tx|{if let Some(j)=tx.db.hosted_job().id().find(&a.job){fail(tx,&j,&e);}});return}};
    let result=inference(ctx,&j);
    // External I/O is finished. Session, conversation, cancellation, grants and policy are checked again.
    let committed=ctx.try_with_tx(|tx|{
        let saved=tx.db.hosted_job().id().find(&j.id).ok_or("Job missing")?;
        if saved.state!="running"{return Ok(())}
        current(tx,&saved)?;
        let value=result.as_ref().map_err(|e|e.clone())?;
        if j.agent==0{commit_plan(tx,&j,value)?;}else{commit_action(tx,&j,value)?;}
        let mut saved=tx.db.hosted_job().id().find(&j.id).unwrap();if saved.state!="attempt"{saved.state="done".into();saved.finished=now(tx);}saved.result=value.to_string();tx.db.hosted_job().id().update(saved);Ok::<_,String>(())
    });
    if let Err(e)=committed{ctx.with_tx(|tx|{if let Some(j)=tx.db.hosted_job().id().find(&j.id){fail(tx,&j,&e);}});}
}
fn metric(ctx:&ReducerContext,j:&Job,error:Option<&str>)->Value{
    let request:Value=serde_json::from_str(&j.request).unwrap_or(Value::Null);
    json!({"type":"inference","stage":if j.agent==0{"coordinator"}else{"specialist"},"agentId":j.agent,"model":request["model"],"status":if error.is_some(){"failed"}else{"completed"},"error":error,"at":j.started,"durationMs":now(ctx)-j.started})
}
fn fail(ctx:&ReducerContext,j:&Job,error:&str){
    if !["queued","running","attempt"].contains(&j.state.as_str()){return}
    let mut saved=j.clone();saved.state="failed".into();saved.result=json!({"error":error}).to_string();saved.finished=now(ctx);ctx.db.hosted_job().id().update(saved);
    // A reset/cancelled generation cannot receive messages, deploy agents, or complete old work.
    if check_chat_epoch(ctx,j.epoch).is_err()||check_conversation(ctx,&j.role,j.generation).is_err(){return}
    if j.agent==0 {
        if let Some(mut t)=ctx.db.backend_chat_turn().id().find(&j.turn){if t.state!="running"{return}t.state="failed".into();t.updated=now(ctx);t.result=json!({"error":error,"metric":metric(ctx,j,Some(error))}).to_string();ctx.db.backend_chat_turn().id().update(t);let _=append_chat_message(ctx,j.generation,format!("{}:reply",j.turn),&j.role,"","coordinator",format!("Decision failed: {}. No fixture fallback was used.",error),0);}
    }else if let Some(mut r)=ctx.db.backend_chat().id().find(&j.operation){
        if r.state!="running"{return}
        let mut records:Vec<Value>=serde_json::from_str(&r.result).unwrap_or_default();records.push(metric(ctx,j,Some(error)));records.push(json!({"type":"worker","agentId":j.agent,"target":j.target,"state":"failed","error":error,"at":now(ctx)}));r.result=json!(records).to_string();ctx.db.backend_chat().id().update(r);finish_operation(ctx,&j.operation);
    }
}
fn commit_plan(ctx:&ReducerContext,j:&Job,v:&Value)->Result<(),String>{
    let intent=v["intent"].as_str().ok_or("provider_malformed_output")?;
    let answer=v["answer"].as_str().filter(|s|!s.trim().is_empty()&&s.len()<=2000).ok_or("provider_malformed_output")?;
    let ids=v["evidenceIds"].as_array().filter(|a|a.len()<=16).ok_or("provider_malformed_output")?;
    let context=fleet::hosted_context(ctx,&j.role,j.target);
    if v.as_object().map(|o|o.len())!=Some(4)||!ids.iter().all(|id|context["evidence"].as_array().unwrap().iter().any(|e|e["id"]==*id)){return Err("provider_malformed_output".into())}
    let tasks=v["tasks"].as_array().ok_or("provider_malformed_output")?;
    let mut operation=String::new();
    if ["deploy","replace"].contains(&intent) {
        if !(2..=4).contains(&tasks.len()){return Err("provider_malformed_output".into())}
        let active=ctx.db.backend_chat().iter().find(|r|r.role==j.role&&["planning","running"].contains(&r.state.as_str()));
        if let Some(mut r)=active {
            if intent!="replace"{return Err("Role operation already active".into())}
            r.state="cancelled".into();chat_transition(ctx,&r.id,"cancelled");ctx.db.backend_chat().id().update(r);
        }
        operation=ctx.new_uuid_v4().map_err(|_|"Identity generation failed")?.to_string();
        let t=ctx.db.backend_chat_turn().id().find(&j.turn).ok_or("Turn missing")?;
        let mut config:Value=serde_json::from_str(&t.config).map_err(|_|"Invalid turn")?;
        config["createdAt"]=json!(now(ctx));config["deadline"]=json!(now(ctx)+75000);config["maxDecisionsPerAgent"]=json!(8);config["maxModelCalls"]=json!(33);config["tasks"]=json!([]);config["turnId"]=json!(j.turn);
        config["models"]=json!({"coordinator":ctx.env.BITDEER_COORDINATOR_MODEL().unwrap_or(MODEL.into()),"specialist":ctx.env.BITDEER_SPECIALIST_MODEL().unwrap_or(MODEL.into())});
        create_chat_operation(ctx,SESSION.into(),operation.clone(),format!("hosted:{}",j.turn),j.role.clone(),j.epoch,config.to_string())?;
        let mut assignments=tasks.clone();
        let first_agent=fleet::hosted_next_agent(ctx)?;
        for (index,task) in assignments.iter_mut().enumerate() {
            if task.as_object().map(|t|t.len())!=Some(4)||task["objective"].as_str().map(|s|s.len()>300).unwrap_or(true){return Err("provider_malformed_output".into())}
            let id=first_agent.checked_add(index as u32).ok_or("Agent identity exhausted")?;
            task["agentId"]=json!(id);
        }
        plan_chat_operation(ctx,SESSION.into(),operation.clone(),json!(assignments).to_string())?;
        ctx.db.hosted_budget().insert(HostedBudget{operation:operation.clone(),calls:1});
        let mut records=vec![metric(ctx,j,None)];
        for task in &assignments {
            let agent=task["agentId"].as_u64().unwrap() as u32;let target=task["target"].as_u64().unwrap() as u32;
            records.push(json!({"type":"worker","agentId":agent,"target":target,"state":"working","at":now(ctx)}));
            insert_job(ctx,Job{id:format!("{}:{}:1",operation,agent),operation:operation.clone(),turn:j.turn.clone(),identity:j.identity,role:j.role.clone(),epoch:j.epoch,generation:j.generation,agent,target,step:1,deadline:now(ctx)+75000,state:"queued".into(),policy:0,request:String::new(),result:String::new(),started:0,finished:0});
        }
        update_chat_operation(ctx,SESSION.into(),operation.clone(),"running".into(),json!(records).to_string())?;
    }else if !["answer","clarify"].contains(&intent)||!tasks.is_empty(){return Err("provider_malformed_output".into())}
    update_chat_turn(ctx,SESSION.into(),j.turn.clone(),"completed".into(),json!({"intent":intent,"operationId":if operation.is_empty(){Value::Null}else{json!(operation)},"metric":metric(ctx,j,None)}).to_string(),if operation.is_empty(){format!("{}{}",answer,if ids.is_empty(){String::new()}else{format!(" Evidence: {}.",ids.iter().map(|n|format!("#{}",n)).collect::<Vec<_>>().join(", "))})}else{"Agents deployed. Results will appear as actions finish.".into()})
}
fn commit_action(ctx:&ReducerContext,j:&Job,v:&Value)->Result<(),String>{
    let kind=v["kind"].as_str().ok_or("provider_malformed_output")?;
    let request:Value=serde_json::from_str(&j.request).map_err(|_|"Invalid reservation")?;
    let allowed=&request["response_format"]["json_schema"]["schema"]["properties"]["kind"]["enum"];
    if v.as_object().map(|o|o.len())!=Some(1)||!allowed.as_array().unwrap().iter().any(|k|k==kind){return Err("provider_malformed_output".into())}
    if kind!="wait"&&fleet::hosted_policy(ctx,j.target)?!=j.policy{return Err("stale_policy".into())}
    fleet::execute_fleet_chat_action(ctx,SESSION.into(),j.operation.clone(),j.step,j.agent,j.target,kind.into(),j.policy)?;
    let mut r=ctx.db.backend_chat().id().find(&j.operation).ok_or("Operation missing")?;
    let mut records:Vec<Value>=serde_json::from_str(&r.result).map_err(|_|"Invalid results")?;records.push(metric(ctx,j,None));
    r.result=json!(records).to_string();ctx.db.backend_chat().id().update(r);
    let receipt=fleet::hosted_receipt(ctx,&j.id);
    complete_action(ctx,j,kind,receipt)?;
    if ctx.db.hosted_job().id().find(&j.id).map(|j|j.state)==Some("attempt".into()){alarm(ctx,&j.id,now(ctx)+500,false);}
    Ok(())
}
fn complete_action(ctx:&ReducerContext,j:&Job,kind:&str,mut receipt:Value)->Result<(),String>{
    let pending=receipt["stage"].as_str().map(|s|s!="resolved").unwrap_or(false);
    receipt["agentId"]=json!(j.agent);receipt["target"]=json!(j.target);receipt["step"]=json!(j.step);receipt["kind"]=json!(kind);receipt["status"]=json!(if pending{"queued"}else{"executed"});receipt["actionId"]=json!(j.id);receipt["at"]=json!(now(ctx));
    let done=!pending&&(kind=="wait"||["command","spread","release"].contains(&kind)||receipt["simulation"]["succeeded"].as_u64().unwrap_or(0)>0&&kind=="verify"||j.step>=8);
    let mut r=ctx.db.backend_chat().id().find(&j.operation).ok_or("Operation missing")?;
    let mut records:Vec<Value>=serde_json::from_str(&r.result).map_err(|_|"Invalid results")?;
    if let Some(old)=records.iter_mut().find(|v|v["actionId"]==j.id){*old=receipt}else{records.push(receipt)}
    if done {records.push(json!({"type":"worker","agentId":j.agent,"target":j.target,"state":if kind=="wait"{"paused"}else{"done"},"at":now(ctx)}));}
    r.result=json!(records).to_string();ctx.db.backend_chat().id().update(r);
    let mut saved=ctx.db.hosted_job().id().find(&j.id).ok_or("Job missing")?;saved.state=if pending{"attempt"}else{"done"}.into();ctx.db.hosted_job().id().update(saved);
    if !pending&&!done {
        let mut next=j.clone();next.step+=1;next.id=format!("{}:{}:{}",j.operation,j.agent,next.step);next.state="queued".into();next.started=0;next.finished=0;next.request.clear();next.result.clear();insert_job(ctx,next);
    }
    if !pending{finish_operation(ctx,&j.operation);}Ok(())
}
pub(super) fn clear_jobs(ctx:&ReducerContext){
 // HTTP already sent cannot be cancelled: retain its slot and watchdog until it returns.
 let inflight:std::collections::HashSet<_>=ctx.db.hosted_job().iter().filter(|j|j.state=="running").map(|j|j.id).collect();
 for a in ctx.db.hosted_alarm().iter(){if !a.watchdog||!inflight.contains(&a.job){ctx.db.hosted_alarm().id().delete(a.id);}}
 for j in ctx.db.hosted_job().iter(){if !inflight.contains(&j.id){ctx.db.hosted_job().id().delete(j.id);}}
 for b in ctx.db.hosted_budget().iter(){ctx.db.hosted_budget().operation().delete(b.operation);}
 assert!(inflight.iter().all(|id|ctx.db.hosted_job().id().find(id.clone()).map(|j|j.state)==Some("running".into())),"Reset must retain outstanding inference reservations");
}

fn finish_operation(ctx:&ReducerContext,id:&str){
    let Some(r)=ctx.db.backend_chat().id().find(id.to_string())else{return};if r.state!="running"{return}
    let config:Value=serde_json::from_str(&r.config).unwrap();let records:Vec<Value>=serde_json::from_str(&r.result).unwrap();
    let all=config["tasks"].as_array().unwrap().iter().all(|t|records.iter().rev().find(|r|r["type"]=="worker"&&r["agentId"]==t["agentId"]).map(|r|r["state"]!="working").unwrap_or(false));
    if all {let state=if records.iter().any(|r|r["type"]=="worker"&&r["state"]=="failed"){"failed"}else{"completed"};let _=update_chat_operation(ctx,SESSION.into(),id.into(),state.into(),r.result);}
}
#[view(accessor=visible_chat_operations,public)]
pub fn visible_chat_operations(ctx:&ViewContext)->Vec<ChatOperation>{let r=fleet::view_role(ctx);let g=visible_conversation_generation(ctx,&r);ctx.db.backend_chat().role().filter(r.as_str()).filter(|o|config_generation(&o.config)==g).collect()}
#[view(accessor=visible_chat_messages,public)]
pub fn visible_chat_messages(ctx:&ViewContext)->Vec<ChatMessage>{let r=fleet::view_role(ctx);let g=visible_conversation_generation(ctx,&r);ctx.db.backend_chat_message().role().filter(r.as_str()).filter(|m|m.key.split(':').nth(3).and_then(|s|s.parse::<u64>().ok())==Some(g)).collect()}
#[view(accessor=visible_chat_turns,public)]
pub fn visible_chat_turns(ctx:&ViewContext)->Vec<ChatTurn>{let r=fleet::view_role(ctx);let g=visible_conversation_generation(ctx,&r);ctx.db.backend_chat_turn().role().filter(r.as_str()).filter(|t|config_generation(&t.config)==g).collect()}

#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn provider_errors_are_truthful(){
  assert_eq!(parse_provider(r#"{"choices":[{"finish_reason":"stop","message":{"refusal":"no"}}]}"#).unwrap_err(),"provider_refused");
  assert_eq!(parse_provider(r#"{"choices":[{"finish_reason":"length","message":{"content":"{}"}}]}"#).unwrap_err(),"provider_truncated_output");
  assert!(parse_provider("broken").is_err());
  assert_eq!(parse_provider(r#"{"choices":[{"finish_reason":"stop","message":{"content":"{\"kind\":\"wait\"}"}}]}"#).unwrap(),json!({"kind":"wait"}));
 }
}

pub(super) fn battle_authorized(ctx:&ReducerContext,operation:&str)->bool {
 let jobs:Vec<_>=ctx.db.hosted_job().iter().filter(|j|j.operation==operation).collect();
 jobs.is_empty()||jobs.iter().any(|j|current(ctx,j).is_ok())
}
