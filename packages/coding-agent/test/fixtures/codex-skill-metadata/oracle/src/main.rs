use serde::{Deserialize,Serialize};
use std::io::{self,BufRead};
use std::path::PathBuf;
mod metadata;
#[derive(Debug,Deserialize,Serialize)]
#[serde(rename_all="lowercase")]
pub enum Product { #[serde(alias="CHATGPT")] Chatgpt, #[serde(alias="CODEX")] Codex, #[serde(alias="ATLAS")] Atlas }
#[derive(Debug,Deserialize)]
pub struct SkillInterfaceFile { display_name:Option<String>,short_description:Option<String>,icon_small:Option<PathBuf>,icon_large:Option<PathBuf>,brand_color:Option<String>,default_prompt:Option<String> }
#[derive(Debug,Serialize)]
pub struct SkillPolicy {allow_implicit_invocation:Option<bool>,products:Vec<Product>}
#[derive(Debug,Serialize)]
pub struct SkillDependencies {tools:Vec<SkillToolDependency>}
#[derive(Debug,Serialize)]
pub struct SkillToolDependency {r#type:String,value:String,description:Option<String>,transport:Option<String>,command:Option<String>,url:Option<String>,oauth_callback_port:Option<u16>}
fn main(){for line in io::stdin().lock().lines(){let input:serde_json::Value=serde_json::from_str(&line.unwrap()).unwrap(); let result=metadata::parse_skill_metadata(input["yaml"].as_str().unwrap());let out=match result{Ok(value)=>serde_json::json!({"ok":true,"policy":value.policy,"dependencies":value.dependencies,"has_interface":value.interface.is_some()}),Err(_)=>serde_json::json!({"ok":false})};println!("{}",serde_json::json!({"id":input["id"],"result":out}));}}
