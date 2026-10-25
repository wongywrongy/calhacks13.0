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
 if ["cancelled","interrupted"].contains(&operation){return "cancelled"}
 match state{"queued" if operation=="running"=>"queued","working"|"running" if operation=="running"=>"running","done"|"completed"=>"completed","cancelled"|"paused"=>"cancelled",_=>"failed"}
}
fn tasks(ctx:&ViewContext,team:&str)->Vec<TaskActivity>{
 let epoch=ctx.db.fleet_session().id().find(0).map(|s|s.epoch).unwrap_or(0);
 let mut out=vec![];
 for op in ctx.db.backend_chat().role().filter(team).filter(|o|o.epoch==epoch){
  let config:Value=serde_json::from_str(&op.config).unwrap_or_default();let records:Vec<Value>=serde_json::from_str(&op.result).unwrap_or_default();
  for task in config["tasks"].as_array().into_iter().flatten(){
   let agent=task["agentId"].as_u64().unwrap_or(0) as u32;
   let lifecycle=records.iter().rev().find(|r|r["type"]=="worker"&&r["agentId"]==agent);
   let state=normalized(lifecycle.and_then(|r|r["state"].as_str()).unwrap_or("queued"),&op.state);
   let receipt=records.iter().rev().find(|r|r["agentId"]==agent&&r["actionId"].is_string());
   let phase=receipt.map(|r|crate::fleet::battle_phase(ctx,r["actionId"].as_str().unwrap())).unwrap_or(Value::Null);
   let mut job=Value::Null;for step in (1..=8).rev(){let value=hosted::view_job(ctx,&format!("{}:{}:{}",op.id,agent,step));if !value.is_null(){job=value;break}}
   let inference=records.iter().rev().find(|r|r["type"]=="inference"&&r["agentId"]==agent);
   let ongoing=["queued","running"].contains(&state);
   let failed_attempt=receipt.map(|r|r["simulation"]["succeeded"].as_u64()==Some(0)&&r["stage"]=="resolved").unwrap_or(false);
   let stage=if !ongoing{state}else if phase["stage"].as_str().map(|s|s!="resolved").unwrap_or(false){"attempt"}
    else if inference.map(|r|r["status"]=="queued").unwrap_or(false){"queued"}else if job["state"]=="attempt"{"evaluating"}else if job["state"]=="running"{if failed_attempt{"reassessing"}else{"assessing"}}
    else if job["state"]=="queued"{if lifecycle.and_then(|r|r["reason"].as_str())==Some("Waiting for an active operation."){ "waiting" }else if failed_attempt{"reassessing"}else{"queued"}}else{lifecycle.and_then(|r|r["stage"].as_str()).unwrap_or(if state=="queued"{"queued"}else if failed_attempt{"reassessing"}else{"assessing"})};
   let reason=lifecycle.and_then(|r|r["reason"].as_str().or_else(||r["error"].as_str())).unwrap_or("");
   let summary=if state=="cancelled"{"Operation cancelled; pending effects cannot apply.".into()}else if !ongoing&&!reason.is_empty(){reason.to_string()}else if !phase["report"]["summary"].is_null(){phase["report"]["summary"].as_str().unwrap_or("").into()}else{reason.into()};
   let at=lifecycle.and_then(|r|r["at"].as_i64()).or_else(||config["createdAt"].as_i64()).unwrap_or(0);
   let at=if ongoing{at}else{at.max(ctx.db.backend_chat_transition().operation().filter(op.id.as_str()).map(|t|t.at).max().unwrap_or(0))};
   out.push(TaskActivity{agent,epoch,role:team.into(),operation:op.id.clone(),name:task["name"].as_str().unwrap_or("Specialist").into(),specialty:task["specialty"].as_str().unwrap_or("").into(),target:task["target"].as_u64().unwrap_or(0) as u32,goal:task_goal(task,team).into(),state:state.into(),stage:stage.into(),summary,updated_at:at,finished_at:if ongoing{0}else{at}});
  }
 }
 out
}
#[view(accessor=visible_agent_tasks,public)]
pub fn visible_agent_tasks(ctx:&ViewContext)->Vec<TaskActivity>{
 let role=crate::fleet::view_role(ctx);let mut out=vec![];for team in ["attacker","defender"]{if role==team||role=="observer"{out.extend(tasks(ctx,team));}}out
}
fn label(stage:&str)->&'static str{match stage{"attempt"=>"Attempt in progress","evaluating"=>"Evaluating the result","reassessing"=>"Preparing a revised attempt","assessing"=>"Assessing reachable targets","queued"=>"Waiting for a decision slot","request"=>"Assessing request","waiting"=>"Waiting for an active operation","blocked"=>"Blocked",_=>"Waiting for user instructions"}}
#[view(accessor=visible_team_activity,public)]
pub fn visible_team_activity(ctx:&ViewContext)->Vec<TeamActivity>{
 let role=crate::fleet::view_role(ctx);let epoch=ctx.db.fleet_session().id().find(0).map(|s|s.epoch).unwrap_or(0);let mut out=vec![];
 for team in ["attacker","defender"]{if role!=team&&role!="observer"{continue}
  let workers=tasks(ctx,team);let active:Vec<_>=workers.iter().filter(|t|["queued","running"].contains(&t.state.as_str())).collect();
  let op=ctx.db.backend_chat().role().filter(team).filter(|o|o.epoch==epoch&&["planning","running"].contains(&o.state.as_str())).max_by_key(|o|serde_json::from_str::<Value>(&o.config).ok().and_then(|v|v["createdAt"].as_i64()).unwrap_or(0));
  let pending=ctx.db.backend_chat_turn().role().filter(team).any(|t|["queued","running"].contains(&t.state.as_str())&&serde_json::from_str::<Value>(&t.config).ok().and_then(|v|v["epoch"].as_u64())==Some(epoch));
  let priority=|s:&str|match s{"attempt"=>0,"evaluating"=>1,"reassessing"=>2,"assessing"=>3,_=>4};
  let primary=active.iter().min_by_key(|t|(priority(&t.stage),t.target));
  let latest=ctx.db.backend_chat().role().filter(team).filter(|o|o.epoch==epoch).max_by_key(|o|serde_json::from_str::<Value>(&o.config).ok().and_then(|v|v["createdAt"].as_i64()).unwrap_or(0));
  let blocked=workers.iter().filter(|t|t.state=="failed"&&latest.as_ref().map(|o|o.id==t.operation).unwrap_or(false)).max_by_key(|t|t.finished_at);
  let stage=if let Some(t)=primary{t.stage.as_str()}else if op.is_some(){"assessing"}else if pending{"request"}else if blocked.map(|t|t.summary.contains("No ")||t.summary.contains("route")||t.summary.contains("budget")).unwrap_or(false){"blocked"}else{"idle"};
  let mut targets:Vec<_>=active.iter().map(|t|t.target).collect();targets.sort_unstable();targets.dedup();
  let config:Value=op.as_ref().and_then(|o|serde_json::from_str(&o.config).ok()).unwrap_or(Value::Null);
  out.push(TeamActivity{role:team.into(),operation:op.as_ref().map(|o|o.id.clone()).unwrap_or_default(),objective:config["message"].as_str().unwrap_or("").into(),targets,stage:stage.into(),summary:if stage=="blocked"{blocked.map(|t|format!("{} — {}",label(stage),t.summary)).unwrap_or_default()}else{label(stage).into()},active_agents:active.len() as u32});
 }
 out
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn closed_operations_never_look_active(){assert_eq!(normalized("running","cancelled"),"cancelled");assert_eq!(normalized("working","completed"),"failed");assert_eq!(normalized("completed","completed"),"completed");assert_eq!(normalized("queued","running"),"queued");}
 #[test]fn goals_are_scoped_to_roles(){assert!(goal_valid("attacker","spread"));assert!(!goal_valid("defender","spread"));assert!(goal_valid("defender","restore"));}
}
