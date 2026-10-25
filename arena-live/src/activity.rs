//! Public operational summaries contain no provider prompt or private reasoning.
use super::*;
use serde_json::Value;
use crate::fleet::fleet_session__view;
#[derive(spacetimedb::SpacetimeType, Clone)]
pub struct TaskActivity {
 agent:u32, epoch:u64, role:String, operation:String, name:String, specialty:String, target:u32,
 goal:String, state:String, stage:String, summary:String, updated_at:i64, finished_at:i64,
}
#[derive(spacetimedb::SpacetimeType)]
pub struct TeamActivity { role:String, operation:String, objective:String, targets:Vec<u32>, stage:String, summary:String, active_agents:u32 }
fn normalized(state:&str,operation:&str)->&'static str{
 if ["done","completed"].contains(&state){return "completed"}
 if ["cancelled","interrupted"].contains(&operation){return "cancelled"}
 match state{"observing" if operation=="running"=>"observing","deciding" if operation=="running"=>"deciding","executing" if operation=="running"=>"executing","waiting" if operation=="running"=>"waiting","queued" if operation=="running"=>"queued","working"|"running" if operation=="running"=>"running","done"|"completed"=>"completed","blocked"=>"blocked","exhausted"=>"exhausted","cancelled"|"paused"=>"cancelled",_=>"failed"}
}
fn tasks(ctx:&SessionView,team:&str)->Vec<TaskActivity>{
 let epoch=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.epoch).unwrap_or(0);
 let mut out=vec![];
 for op in ctx.db.backend_chat().session_scope().filter((ctx.session_id,team,epoch,visible_conversation_generation(ctx,team))).map(ScopedRow::local).map(|op|view_operation(ctx,op)){
  let config:Value=serde_json::from_str(&op.config).unwrap_or_default();let records:Vec<Value>=serde_json::from_str(&op.result).unwrap_or_default();
  for task in config["tasks"].as_array().into_iter().flatten(){
   let agent=task["agentId"].as_u64().unwrap_or(0) as u32;
   let lifecycle=records.iter().rev().find(|r|r["type"]=="worker"&&r["agentId"]==agent);
   let state=normalized(lifecycle.and_then(|r|r["state"].as_str()).unwrap_or("queued"),&op.state);
   let receipt=records.iter().rev().find(|r|r["agentId"]==agent&&r["actionId"].is_string());
   let phase=receipt.map(|r|crate::fleet::battle_phase(ctx,r["actionId"].as_str().unwrap())).unwrap_or(Value::Null);
   let mut job=Value::Null;for step in (1..=8).rev(){let value=hosted::view_job(ctx,&format!("{}:{}:{}",op.id,agent,step));if !value.is_null(){job=value;break}}
   let inference=records.iter().rev().find(|r|r["type"]=="inference"&&r["agentId"]==agent);
   let ongoing=["queued","running","observing","deciding","executing","waiting"].contains(&state);
   let failed_attempt=receipt.map(|r|r["simulation"]["succeeded"].as_u64()==Some(0)&&r["stage"]=="resolved").unwrap_or(false);
   let stage=if !ongoing{state}else if phase["stage"].as_str().map(|s|s!="resolved").unwrap_or(false){"attempt"}
    else if inference.map(|r|r["status"]=="queued").unwrap_or(false){"queued"}else if job["state"]=="waiting"{"waiting"}else if job["state"]=="attempt"{"evaluating"}else if job["state"]=="running"{if failed_attempt{"reassessing"}else{"assessing"}}
    else if job["state"]=="queued"{if lifecycle.and_then(|r|r["reason"].as_str())==Some("Waiting for an active operation."){ "waiting" }else{"queued"}}else{lifecycle.and_then(|r|r["stage"].as_str()).unwrap_or(if state=="queued"{"queued"}else if failed_attempt{"reassessing"}else{"assessing"})};
   let reason=lifecycle.and_then(|r|r["reason"].as_str().or_else(||r["error"].as_str())).unwrap_or("");
   let summary=if state=="cancelled"{"Operation cancelled; pending effects cannot apply.".into()}else if !ongoing&&!reason.is_empty(){reason.to_string()}else if !phase["report"]["summary"].is_null(){format!("{} {}",reason,phase["report"]["summary"].as_str().unwrap_or(""))}else{reason.into()};
   let at=lifecycle.and_then(|r|r["at"].as_i64()).or_else(||config["createdAt"].as_i64()).unwrap_or(0);
   let at=if ongoing{at}else{at.max(ctx.db.backend_chat_transition().session_operation().filter((ctx.session_id,op.id.as_str())).map(ScopedRow::local).map(|t|t.at).max().unwrap_or(0))};
   out.push(TaskActivity{agent,epoch,role:team.into(),operation:op.id.clone(),name:task["name"].as_str().unwrap_or("Specialist").into(),specialty:task["specialty"].as_str().unwrap_or("").into(),target:task["target"].as_u64().unwrap_or(0) as u32,goal:task_goal(task,team).into(),state:state.into(),stage:stage.into(),summary,updated_at:at,finished_at:if ongoing{0}else{at}});
  }
 }
 out
}
#[view(accessor=visible_agent_tasks,public)]
pub fn visible_agent_tasks(raw:&spacetimedb::ViewContext) ->Vec<TaskActivity> { let ctx=SessionView::for_sender(raw);visible_agent_tasks_scoped(&ctx) }
pub(crate) fn visible_agent_tasks_scoped(ctx:&SessionView)->Vec<TaskActivity>{
 let role=crate::fleet::view_role(ctx);let mut out=vec![];for team in ["attacker","defender"]{if role==team||role=="observer"{out.extend(tasks(ctx,team));}}out
}
fn label(stage:&str)->&'static str{match stage{"attempt"=>"Attempt in progress","evaluating"=>"Evaluating the result","reassessing"=>"Deciding the next action","assessing"=>"Deciding the next action","queued"=>"Waiting for a decision slot","request"=>"Request queued","waiting"=>"Waiting for fresh observations","blocked"=>"Blocked","execution_failure"=>"Request failed; no simulated result was established",_=>"Waiting for user instructions"}}
#[view(accessor=visible_team_activity,public)]
pub fn visible_team_activity(raw:&spacetimedb::ViewContext) ->Vec<TeamActivity> { let ctx=SessionView::for_sender(raw);visible_team_activity_scoped(&ctx) }
pub(crate) fn visible_team_activity_scoped(ctx:&SessionView)->Vec<TeamActivity>{
 let role=crate::fleet::view_role(ctx);let epoch=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.epoch).unwrap_or(0);let mut out=vec![];
 for team in ["attacker","defender"]{if role!=team&&role!="observer"{continue}
  let workers=tasks(ctx,team);let active:Vec<_>=workers.iter().filter(|t|["queued","running","observing","deciding","executing","waiting"].contains(&t.state.as_str())).collect();
  let op=ctx.db.backend_chat().session_scope().filter((ctx.session_id,team,epoch,visible_conversation_generation(ctx,team))).map(ScopedRow::local).filter(|o|["planning","running"].contains(&o.state.as_str())).map(|op|view_operation(ctx,op)).max_by_key(|o|serde_json::from_str::<Value>(&o.config).ok().and_then(|v|v["createdAt"].as_i64()).unwrap_or(0));
  let pending=ctx.db.backend_chat_turn().session_scope().filter((ctx.session_id,team,epoch,visible_conversation_generation(ctx,team))).map(ScopedRow::local).find(|t|["queued","running"].contains(&t.state.as_str()));
  let deciding=pending.as_ref().map(|t|hosted::view_job(ctx,&t.id)["state"]=="running").unwrap_or(false)||op.as_ref().map(|o|(1..=2).any(|n|hosted::view_job(ctx,&format!("{}:replan:{}",o.id,n))["state"]=="running")).unwrap_or(false);
  let priority=|s:&str|match s{"attempt"=>0,"evaluating"=>1,"reassessing"=>2,"assessing"=>3,_=>4};
  let primary=active.iter().min_by_key(|t|(priority(&t.stage),t.target));
  let latest=ctx.db.backend_chat().session_scope().filter((ctx.session_id,team,epoch,visible_conversation_generation(ctx,team))).map(ScopedRow::local).map(|op|view_operation(ctx,op)).max_by_key(|o|serde_json::from_str::<Value>(&o.config).ok().and_then(|v|v["createdAt"].as_i64()).unwrap_or(0));
  let blocked=workers.iter().filter(|t|["failed","blocked","exhausted"].contains(&t.state.as_str())&&latest.as_ref().map(|o|o.id==t.operation).unwrap_or(false)).max_by_key(|t|t.finished_at);
  let request_failed=ctx.db.backend_chat_turn().session_scope().filter((ctx.session_id,team,epoch,visible_conversation_generation(ctx,team))).map(ScopedRow::local).max_by_key(|t|t.created).map(|t|t.state=="failed"&&latest.as_ref().map(|o|serde_json::from_str::<Value>(&o.config).ok().and_then(|v|v["createdAt"].as_i64()).unwrap_or(0)<=t.created).unwrap_or(true)).unwrap_or(false);
  let stage=if let Some(t)=primary{t.stage.as_str()}else if deciding{"assessing"}else if op.is_some(){"queued"}else if pending.is_some(){"request"}else if request_failed{"execution_failure"}else if blocked.map(|t|t.summary.contains("No ")||t.summary.contains("route")||t.summary.contains("budget")).unwrap_or(false){"blocked"}else{"idle"};
  let mut targets:Vec<_>=active.iter().map(|t|t.target).collect();targets.sort_unstable();targets.dedup();
  let config:Value=op.as_ref().and_then(|o|serde_json::from_str(&o.config).ok()).unwrap_or(Value::Null);
  out.push(TeamActivity{role:team.into(),operation:op.as_ref().map(|o|o.id.clone()).unwrap_or_default(),objective:config["message"].as_str().unwrap_or("").into(),targets,stage:stage.into(),summary:if stage=="blocked"{blocked.map(|t|format!("{} — {}",label(stage),t.summary)).unwrap_or_default()}else{label(stage).into()},active_agents:active.len() as u32});
 }
 out
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn closed_operations_never_look_active(){assert_eq!(normalized("running","cancelled"),"cancelled");assert_eq!(normalized("completed","cancelled"),"completed");assert_eq!(normalized("working","completed"),"failed");assert_eq!(normalized("completed","completed"),"completed");assert_eq!(normalized("queued","running"),"queued");}
 #[test]fn goals_are_scoped_to_roles(){assert!(goal_valid("attacker","spread"));assert!(!goal_valid("defender","spread"));assert!(goal_valid("defender","restore"));}
}
