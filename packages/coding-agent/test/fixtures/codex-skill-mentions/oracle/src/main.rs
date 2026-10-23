use std::io::{self,BufRead};
mod mentions;
fn main(){for line in io::stdin().lock().lines(){let input:serde_json::Value=serde_json::from_str(&line.unwrap()).unwrap();let result=mentions::extract_tool_mentions(input["text"].as_str().unwrap());let mut names:Vec<_>=result.plain_names().collect();names.sort();let mut paths:Vec<_>=result.paths().collect();paths.sort();println!("{}",serde_json::json!({"plainNames":names,"paths":paths}));}}
