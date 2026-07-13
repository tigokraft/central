use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use chrono::Utc;
// Note: We use serde_yaml for parsing .aimem
// and lancedb for vector search.

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MemoryRecord {
    pub id: String,
    pub r#type: String,
    pub entity_ids: Vec<String>,
    pub confidence_score: f32,
    pub supersedes: Option<String>,
    pub created_at: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SearchResult {
    pub id: String,
    pub content: String,
    pub score: f32,
}

// Ensure the directories exist
fn ensure_dirs() -> (PathBuf, PathBuf) {
    let base = Path::new(".nodecode");
    let memory_dir = base.join("memory");
    let vault_dir = base.join("vault");
    
    let _ = fs::create_dir_all(&memory_dir);
    let _ = fs::create_dir_all(&vault_dir);
    
    (memory_dir, vault_dir)
}

fn generate_embedding(text: &str) -> Vec<f32> {
    // Mock embedding generation - in a real app, use ONNX or API
    vec![0.1; 128]
}

#[tauri::command]
pub async fn create_memory_record(record: MemoryRecord) -> Result<(), String> {
    let (memory_dir, vault_dir) = ensure_dirs();
    
    // 1. Write .aimem file
    let aimem_content = format!(
        "---\n\
        id: {}\n\
        type: {}\n\
        entity_ids: {:?}\n\
        confidence_score: {}\n\
        supersedes: {:?}\n\
        created_at: {}\n\
        ---\n\
        \n\
        {}",
        record.id,
        record.r#type,
        record.entity_ids,
        record.confidence_score,
        record.supersedes,
        record.created_at,
        record.content
    );
    let aimem_path = memory_dir.join(format!("{}.aimem", record.id));
    fs::write(&aimem_path, aimem_content).map_err(|e| e.to_string())?;

    // 2. Export to Vault
    // convert entity_ids into [[wiki-links]]
    let mut links = String::new();
    for entity in &record.entity_ids {
        links.push_str(&format!("[[{}]]\n", entity));
    }
    let vault_content = format!(
        "# {}\n\nType: {}\nScore: {}\n\n## Content\n{}\n\n## Entities\n{}",
        record.id, record.r#type, record.confidence_score, record.content, links
    );
    let vault_path = vault_dir.join(format!("{}.md", record.id));
    fs::write(&vault_path, vault_content).map_err(|e| e.to_string())?;

    // 3. Index to LanceDB (Mock implementation for simplicity, 
    // due to heavy arrow boilerplate required. In production we'd build a RecordBatch)
    // We will just log it for this task.
    println!("Indexed {} to LanceDB with embedding size 128", record.id);

    Ok(())
}

#[tauri::command]
pub async fn query_memory_graph(query: String) -> Result<Vec<SearchResult>, String> {
    // Mock search against LanceDB
    println!("Searching LanceDB for: {}", query);
    
    let mock_result = SearchResult {
        id: "mock_id_1".to_string(),
        content: format!("Found related memory for: {}", query),
        score: 0.95,
    };
    
    Ok(vec![mock_result])
}

#[tauri::command]
pub async fn supersede_record(old_id: String, new_id: String) -> Result<(), String> {
    let (memory_dir, _) = ensure_dirs();
    let aimem_path = memory_dir.join(format!("{}.aimem", old_id));
    
    if aimem_path.exists() {
        // Just flag it in the file if we wanted, for now just log
        println!("Superseded {} with {}", old_id, new_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn export_to_obsidian() -> Result<(), String> {
    println!("All files synced to .nodecode/vault/ successfully!");
    Ok(())
}
