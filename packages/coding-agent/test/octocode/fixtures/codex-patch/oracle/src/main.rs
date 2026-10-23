use std::io::{self, BufRead};
use serde_json::{json,Value};
mod parser;mod streaming_parser;mod seek_sequence;mod text_file;mod file_update;
pub use parser::UpdateFileChunk;
#[derive(Debug,PartialEq)] pub struct ApplyPatchArgs { pub hunks:Vec<parser::Hunk>,pub patch:String,pub workdir:Option<String>,pub environment_id:Option<String> }
#[derive(Debug,thiserror::Error)] pub enum ApplyPatchError { #[error("{0}")] ComputeReplacements(String) }
fn run(v:Value)->Value {
 let patch=v["patch"].as_str().unwrap();
 match parser::parse_patch(patch) {
 Err(e)=>json!({"ok":false,"error":e.to_string()}),
 Ok(args)=> { let mut hunks=Vec::new();
 for h in args.hunks { match h {
 parser::Hunk::AddFile{path,contents}=>hunks.push(json!({"kind":"add","path":path,"content":contents})),
 parser::Hunk::DeleteFile{path}=>hunks.push(json!({"kind":"delete","path":path})),
 parser::Hunk::UpdateFile{path,move_path,chunks}=> {
 let details:Vec<Value>=chunks.iter().map(|c|json!({"context":c.change_context,"old":c.old_lines,"new":c.new_lines,"context_indices":c.context_line_indices,"eof":c.is_end_of_file})).collect();
 let mut h=json!({"kind":"update","path":path,"move_path":move_path,"chunks":details});
 if let Some(source)=v["source"].as_str() { match file_update::transform(source,&chunks) { Ok(text)=>{h["output"]=json!(text);},Err(e)=>{h["error"]=json!(e.to_string());} } }
 hunks.push(h);
 }}}
 json!({"ok":true,"patch":args.patch,"environment_id":args.environment_id,"hunks":hunks})
 }
 }
}
fn main(){ for line in io::stdin().lock().lines() { let line=line.unwrap(); match serde_json::from_str(&line) {Ok(v)=>println!("{}",run(v)),Err(e)=>println!("{}",json!({"input_error":e.to_string()}))} } }
