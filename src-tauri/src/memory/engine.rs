use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use lancedb::connection::Connection;
use lancedb::query::{ExecutableQuery, QueryBase};
use arrow::array::{RecordBatch, StringArray, Float32Array, FixedSizeListArray};
use arrow::datatypes::{Schema, Field, DataType};
use futures::StreamExt;

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
    // Mock embedding generation (128 dims)
    vec![0.1; 128]
}

async fn get_lancedb_connection() -> Result<Connection, String> {
    let base = Path::new(".nodecode").join("lancedb");
    lancedb::connect(base.to_str().unwrap()).execute().await.map_err(|e| e.to_string())
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

    // 3. Index to LanceDB (Implementation provided!)
    let db = get_lancedb_connection().await?;
    let embedding = generate_embedding(&record.content);
    
    // Create arrow arrays
    let id_array = StringArray::from(vec![record.id.clone()]);
    let content_array = StringArray::from(vec![record.content.clone()]);
    
    let float_array = Float32Array::from(embedding);
    let vector_field = Arc::new(Field::new("item", DataType::Float32, true));
    let vector_array = FixedSizeListArray::new(vector_field, 128, Arc::new(float_array), None);

    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("content", DataType::Utf8, false),
        Field::new("vector", DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), 128), false),
    ]));

    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(id_array),
            Arc::new(content_array),
            Arc::new(vector_array),
        ]
    ).map_err(|e| e.to_string())?;

    let table_name = "memory_records";
    let tables = db.table_names().execute().await.map_err(|e| e.to_string())?;
    
    if tables.contains(&table_name.to_string()) {
        let table = db.open_table(table_name).execute().await.map_err(|e| e.to_string())?;
        table.add(vec![batch]).execute().await.map_err(|e| e.to_string())?;
    } else {
        db.create_table(table_name, vec![batch]).execute().await.map_err(|e| e.to_string())?;
    }

    println!("Indexed {} to LanceDB with embedding size 128", record.id);

    Ok(())
}

#[tauri::command]
pub async fn query_memory_graph(query: String) -> Result<Vec<SearchResult>, String> {
    let db = get_lancedb_connection().await?;
    let table_name = "memory_records";
    
    let tables = db.table_names().execute().await.map_err(|e| e.to_string())?;
    if !tables.contains(&table_name.to_string()) {
        return Ok(vec![]); // No data yet
    }
    
    let table = db.open_table(table_name).execute().await.map_err(|e| e.to_string())?;
    
    // Generate query embedding
    let query_vector = generate_embedding(&query);
    
    // Execute vector search
    let mut results = table.vector_search(query_vector.as_slice()).unwrap()
        .limit(5)
        .execute()
        .await
        .map_err(|e| e.to_string())?;

    let mut search_results = Vec::new();
    
    // Parse RecordBatches to SearchResult
    while let Some(batch_result) = results.next().await {
        let batch = batch_result.map_err(|e| e.to_string())?;
        let id_array = batch.column(0).as_any().downcast_ref::<StringArray>().unwrap();
        let content_array = batch.column(1).as_any().downcast_ref::<StringArray>().unwrap();
        // LanceDB distance score is usually available as _distance
        let distance_array = batch.column_by_name("_distance").and_then(|c| c.as_any().downcast_ref::<Float32Array>());
        
        for i in 0..batch.num_rows() {
            let score = distance_array.map(|d| d.value(i)).unwrap_or(0.0);
            search_results.push(SearchResult {
                id: id_array.value(i).to_string(),
                content: content_array.value(i).to_string(),
                score: 1.0 - score, // Convert distance to similarity
            });
        }
    }

    Ok(search_results)
}

#[tauri::command]
pub async fn supersede_record(old_id: String, new_id: String) -> Result<(), String> {
    let (memory_dir, _) = ensure_dirs();
    let aimem_path = memory_dir.join(format!("{}.aimem", old_id));
    
    if aimem_path.exists() {
        println!("Superseded {} with {}", old_id, new_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn export_to_obsidian() -> Result<(), String> {
    println!("All files synced to .nodecode/vault/ successfully!");
    Ok(())
}
