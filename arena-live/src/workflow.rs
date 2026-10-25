//! Hosted storage adapter. JSON returned to old clients is a projection, never a second store.
use super::*;
use serde_json::{json, Value};

#[table(accessor=hosted_workflow)]
#[derive(Clone)]
pub struct Workflow {
    #[primary_key] id:String,
    created:i64, deadline:i64, replans:u32, contract_ready:bool, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=hosted_assignment ,index(accessor=session_operation, btree(columns=[session_id,operation])),index(accessor=session_agent, btree(columns=[session_id,agent])))]
#[derive(Clone)]
pub struct Assignment {
    #[primary_key] id:String,
    #[index(btree)] operation:String,
    #[index(btree)] agent:u32,
    epoch:u64, generation:u64, role:String,
    name:String, specialty:String, objective:String, goal:String,
    target:u32, targets:Vec<u32>,
    state:String, reason:String, error:String, updated:i64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=hosted_record ,index(accessor=session_operation, btree(columns=[session_id,operation])))]
#[derive(Clone)]
pub struct Record {
    #[primary_key] id:String,
    #[index(btree)] operation:String,
    sequence:u32, body:String, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }

fn project(mut op:ChatOperation,w:Workflow,mut assignments:Vec<Assignment>,mut history:Vec<Record>)->ChatOperation {
    let mut config:Value=serde_json::from_str(&op.config).expect("Validated config");
    config["conversation"]=json!(op.generation);config["createdAt"]=json!(w.created);
    config["deadline"]=json!(w.deadline);config["replans"]=json!(w.replans);
    assignments.sort_by_key(|a|a.agent);
    config["tasks"]=json!(assignments.iter().map(|a|json!({"agentId":a.agent,"name":a.name,"specialty":a.specialty,"objective":a.objective,"goal":a.goal,"target":a.target})).collect::<Vec<_>>());
    if w.contract_ready {
        config["completionConditions"]=json!(assignments.iter().map(|a|json!({"agentId":a.agent,"goal":a.goal,"targets":a.targets,"required":1})).collect::<Vec<_>>());
    }
    history.sort_by_key(|r|r.sequence);
    let mut rows:Vec<Value>=history.into_iter().map(|r|serde_json::from_str(&r.body).expect("Validated record")).collect();
    // Historical transitions explain a run; only the typed assignment defines current lifecycle.
    for a in assignments {
        let worker=json!({"type":"worker","agentId":a.agent,"target":a.target,"state":a.state,"reason":a.reason,"error":if a.error.is_empty(){Value::Null}else{json!(a.error)},"at":a.updated});
        if let Some(last)=rows.iter_mut().rev().find(|r|r["type"]=="worker"&&r["agentId"]==a.agent){*last=worker;}
    }
    op.config=config.to_string();op.result=json!(rows).to_string();op
}
pub(super) fn hydrate_operation(ctx:&SessionContext,op:ChatOperation)->ChatOperation {
    let Some(w)=ctx.db.hosted_workflow().id().find(session_key(ctx.session_id, &(&op.id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return op};
    let assignments=ctx.db.hosted_assignment().session_operation().filter((ctx.session_id,op.id.as_str())).map(ScopedRow::local).collect();
    let records=ctx.db.hosted_record().session_operation().filter((ctx.session_id,op.id.as_str())).map(ScopedRow::local).collect();
    project(op,w,assignments,records)
}
pub(super) fn view_operation(ctx:&SessionView,op:ChatOperation)->ChatOperation {
    let Some(w)=ctx.db.hosted_workflow().id().find(session_key(ctx.session_id, &(&op.id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return op};
    let assignments=ctx.db.hosted_assignment().session_operation().filter((ctx.session_id,op.id.as_str())).map(ScopedRow::local).collect();
    let records=ctx.db.hosted_record().session_operation().filter((ctx.session_id,op.id.as_str())).map(ScopedRow::local).collect();
    project(op,w,assignments,records)
}
pub(super) fn store_operation(ctx:&SessionContext,mut op:ChatOperation) {
    let Some(mut w)=ctx.db.hosted_workflow().id().find(session_key(ctx.session_id, &(&op.id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{ctx.db.backend_chat().id().update(ScopedRow::stored(op,ctx.session_id)).local();return};
    let mut config:Value=serde_json::from_str(&op.config).expect("Validated operation");
    let rows:Vec<Value>=serde_json::from_str(&op.result).expect("Validated records");
    assert!(rows.len()<=512,"Bounded mission history");
    w.deadline=config["deadline"].as_i64().expect("Deadline");w.replans=config["replans"].as_u64().unwrap_or(0) as u32;
    for t in config["tasks"].as_array().into_iter().flatten() {
        let agent=t["agentId"].as_u64().expect("Agent") as u32;
        let id=format!("{}:{}",op.id,agent);
        let old=ctx.db.hosted_assignment().id().find(session_key(ctx.session_id, &(&id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local);
        let contract=config["completionConditions"].as_array().and_then(|cs|cs.iter().find(|c|c["agentId"]==agent));
        let targets=contract.and_then(|c|c["targets"].as_array()).map(|ts|ts.iter().map(|n|n.as_u64().expect("Target") as u32).collect()).unwrap_or_else(||vec![t["target"].as_u64().expect("Target") as u32]);
        if let Some(ref a)=old {if w.contract_ready{assert_eq!(a.targets,targets,"Immutable scope");assert_eq!(a.goal,task_goal(t,&op.role),"Immutable goal");}}
        let worker=rows.iter().rev().find(|r|r["type"]=="worker"&&r["agentId"]==agent);
        let mut a=Assignment{session_id:ctx.session_id,id,operation:op.id.clone(),agent,epoch:op.epoch,generation:op.generation,role:op.role.clone(),name:t["name"].as_str().unwrap_or("Specialist").into(),specialty:t["specialty"].as_str().unwrap_or("").into(),objective:t["objective"].as_str().unwrap_or("").into(),goal:task_goal(t,&op.role).into(),target:t["target"].as_u64().expect("Target") as u32,targets,
            state:worker.and_then(|r|r["state"].as_str()).unwrap_or("queued").into(),reason:worker.and_then(|r|r["reason"].as_str()).unwrap_or("").into(),error:worker.and_then(|r|r["error"].as_str()).unwrap_or("").into(),updated:worker.and_then(|r|r["at"].as_i64()).unwrap_or(w.created)};
        assert!(a.targets.contains(&a.target)&&goal_valid(&op.role,&a.goal),"Validated assignment scope and goal");
        assert!(["queued","running","working","observing","deciding","executing","waiting","completed","done","blocked","failed","exhausted","cancelled","paused"].contains(&a.state.as_str()),"Validated assignment lifecycle");
        if !["planning","running"].contains(&op.state.as_str())&&["queued","running","working","observing","deciding","executing","waiting"].contains(&a.state.as_str()) {
            a.state=if ["cancelled","interrupted"].contains(&op.state.as_str()){"cancelled"}else{"failed"}.into();a.reason=format!("Operation {}.",op.state);a.updated=now(ctx);
        }
        if old.is_some(){ctx.db.hosted_assignment().id().update(ScopedRow::stored(a,ctx.session_id)).local();}else{ctx.db.hosted_assignment().insert(ScopedRow::stored(a,ctx.session_id)).local();}
    }
    w.contract_ready|=config["completionConditions"].is_array();
    for (sequence,row) in rows.iter().enumerate() {
        let id=format!("{}:{}",op.id,sequence);
        let body=row.to_string();
        if let Some(old)=ctx.db.hosted_record().id().find(session_key(ctx.session_id, &(&id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local){
            if old.body!=body{ctx.db.hosted_record().id().update(ScopedRow::stored(Record{body,..old},ctx.session_id)).local();}
        }else{ctx.db.hosted_record().insert(ScopedRow::stored(Record{session_id:ctx.session_id,id,operation:op.id.clone(),sequence:sequence as u32,body},ctx.session_id)).local();}
    }
    for key in ["tasks","scopes","completionConditions","conversation","createdAt","deadline","replans"]{config.as_object_mut().unwrap().remove(key);}
    op.config=config.to_string();op.result="[]".into();
    ctx.db.hosted_workflow().id().update(ScopedRow::stored(w,ctx.session_id)).local();ctx.db.backend_chat().id().update(ScopedRow::stored(op,ctx.session_id)).local();
}
pub(super) fn normalize_operation(ctx:&SessionContext,mut op:ChatOperation)->Result<(),String> {
    if ctx.db.hosted_workflow().id().find(session_key(ctx.session_id, &(&op.id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some(){return Ok(())}
    let mut config:Value=serde_json::from_str(&op.config).map_err(|_|"Invalid legacy operation")?;
    let rows:Vec<Value>=serde_json::from_str(&op.result).map_err(|_|"Invalid legacy history")?;
    if rows.len()>512||!config.is_object(){return Err("Legacy mission exceeds migration bounds".into())}
    op.generation=config_generation(&op.config);
    if !config["completionConditions"].is_array()&&config["tasks"].as_array().map(|ts|!ts.is_empty()).unwrap_or(false){
        config["completionConditions"]=json!(config["tasks"].as_array().unwrap().iter().map(|t|{
            let targets=config["scopes"][t["agentId"].as_u64().unwrap().to_string()].as_array().cloned().unwrap_or_else(||vec![t["target"].clone()]);
            json!({"agentId":t["agentId"],"goal":task_goal(t,&op.role),"targets":targets,"required":1})
        }).collect::<Vec<_>>());
    }
    op.config=config.to_string();
    let w=Workflow{session_id:ctx.session_id,id:op.id.clone(),created:config["createdAt"].as_i64().unwrap_or(0),deadline:config["deadline"].as_i64().ok_or("Missing legacy deadline")?,replans:0,contract_ready:false};
    ctx.db.hosted_workflow().insert(ScopedRow::stored(w,ctx.session_id)).local();store_operation(ctx,op);Ok(())
}

// A bounded owner-only backfill. Parsing legacy keys is confined to this migration boundary.
#[reducer]
pub fn migrate_hosted_workflow(raw:&spacetimedb::ReducerContext, operations:Vec<String>, turns:Vec<String>, messages:Vec<u64>) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;migrate_hosted_workflow_scoped(&ctx ,operations,turns,messages) }
pub(crate) fn migrate_hosted_workflow_scoped(ctx:&SessionContext,operations:Vec<String>,turns:Vec<String>,messages:Vec<u64>)->Result<(),String>{
    owner(ctx)?;
    if operations.len()+turns.len()+messages.len()>100{return Err("Migration batch limit is 100".into())}
    for id in operations {
        let op=ctx.db.backend_chat().id().find(session_key(ctx.session_id, &(&id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Operation missing")?;
        if op.request_key.starts_with("hosted:"){normalize_operation(ctx,op)?;}
        else if op.generation==0{let mut op=op;op.generation=config_generation(&op.config);ctx.db.backend_chat().id().update(ScopedRow::stored(op,ctx.session_id)).local();}
    }
    for id in turns {
        let mut t=ctx.db.backend_chat_turn().id().find(session_key(ctx.session_id, &(&id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Turn missing")?;
        if t.epoch!=0{continue}
        let config:Value=serde_json::from_str(&t.config).map_err(|_|"Invalid legacy turn")?;
        t.epoch=config["epoch"].as_u64().ok_or("Missing legacy epoch")?;t.generation=config_generation(&t.config);
        ctx.db.backend_chat_turn().id().update(ScopedRow::stored(t,ctx.session_id)).local();
    }
    for id in messages {
        let mut m=ctx.db.backend_chat_message().id().find(id).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Message missing")?;
        if m.epoch!=0{continue}
        let parts:Vec<_>=m.key.split(':').collect();
        if parts.len()<5||parts[0]!="epoch"||parts[2]!="chat"{return Err("Invalid legacy message scope".into())}
        m.epoch=parts[1].parse().map_err(|_|"Invalid legacy epoch")?;m.generation=parts[3].parse().map_err(|_|"Invalid legacy generation")?;
        ctx.db.backend_chat_message().id().update(ScopedRow::stored(m,ctx.session_id)).local();
    }
    Ok(())
}

pub(super) fn hosted_has_assignment(ctx:&SessionContext,epoch:u64,agent:u32)->bool{ctx.db.hosted_assignment().session_agent().filter((ctx.session_id,agent)).map(ScopedRow::local).any(|a|a.epoch==epoch)}

pub(super) fn is_hosted_operation(ctx:&SessionContext,id:&str)->bool{ctx.db.hosted_workflow().id().find(session_key(ctx.session_id, &(id.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some()}

// Preserve the original public view rows while private tables gain scope columns.
#[derive(spacetimedb::SpacetimeType)]
pub struct OperationRow { id:String, request_key:String, role:String, epoch:u64, state:String, config:String, result:String }
impl From<ChatOperation> for OperationRow {
    fn from(o:ChatOperation)->Self{Self{id:o.id,request_key:o.request_key,role:o.role,epoch:o.epoch,state:o.state,config:o.config,result:o.result}}
}
#[derive(spacetimedb::SpacetimeType)]
pub struct MessageRow { id:u64,key:String,role:String,operation:String,speaker:String,text:String,target:u32,at:i64 }
impl From<ChatMessage> for MessageRow {
    fn from(m:ChatMessage)->Self{Self{id:m.id,key:m.key,role:m.role,operation:m.operation,speaker:m.speaker,text:m.text,target:m.target,at:m.at}}
}
#[derive(spacetimedb::SpacetimeType)]
pub struct TurnRow { id:String,request_key:String,role:String,state:String,config:String,result:String,created:i64,updated:i64 }
impl From<ChatTurn> for TurnRow {
    fn from(t:ChatTurn)->Self{Self{id:t.id,request_key:t.request_key,role:t.role,state:t.state,config:t.config,result:t.result,created:t.created,updated:t.updated}}
}

impl ScopedRow for Workflow { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=session_key(session,&self.id);self} fn local(mut self)->Self{self.id=local_key(self.session_id,&self.id);self}}

impl ScopedRow for Assignment { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=session_key(session,&self.id);self} fn local(mut self)->Self{self.id=local_key(self.session_id,&self.id);self}}

impl ScopedRow for Record { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=session_key(session,&self.id);self} fn local(mut self)->Self{self.id=local_key(self.session_id,&self.id);self}}

pub(crate) fn delete_session_state(raw:&spacetimedb::ReducerContext,session:u32){
for row in raw.db.hosted_workflow().session_id().filter(session){raw.db.hosted_workflow().id().delete(row.id);}
for row in raw.db.hosted_assignment().session_id().filter(session){raw.db.hosted_assignment().id().delete(row.id);}
for row in raw.db.hosted_record().session_id().filter(session){raw.db.hosted_record().id().delete(row.id);}
}
