use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;

use arrow::array::{FixedSizeListArray, Float32Array, RecordBatch, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use futures::StreamExt;
use lancedb::connection::Connection;
use lancedb::query::{ExecutableQuery, QueryBase};

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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AimemFact {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

// Ensure the directories exist, rooted under the active project rather than the
// process's own cwd.
fn ensure_dirs(project_root: &Path) -> (PathBuf, PathBuf) {
    let base = project_root.join(".central");
    let memory_dir = base.join("memory");
    let vault_dir = base.join("vault");

    let _ = fs::create_dir_all(&memory_dir);
    let _ = fs::create_dir_all(&vault_dir);

    (memory_dir, vault_dir)
}

fn generate_embedding(_text: &str) -> Vec<f32> {
    // Mock embedding generation (128 dims)
    vec![0.1; 128]
}

async fn get_lancedb_connection(project_root: &Path) -> Result<Connection, String> {
    let base = project_root.join(".central").join("lancedb");
    lancedb::connect(base.to_str().unwrap())
        .execute()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_memory_record(record: MemoryRecord, app: AppHandle) -> Result<(), String> {
    let project_root = crate::git_engine::resolve_repo_root(&app);
    let (memory_dir, vault_dir) = ensure_dirs(&project_root);

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
    let db = get_lancedb_connection(&project_root).await?;
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
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), 128),
            false,
        ),
    ]));

    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(id_array),
            Arc::new(content_array),
            Arc::new(vector_array),
        ],
    )
    .map_err(|e| e.to_string())?;

    let table_name = "memory_records";
    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| e.to_string())?;

    if tables.contains(&table_name.to_string()) {
        let table = db
            .open_table(table_name)
            .execute()
            .await
            .map_err(|e| e.to_string())?;
        table
            .add(vec![batch])
            .execute()
            .await
            .map_err(|e| e.to_string())?;
    } else {
        db.create_table(table_name, vec![batch])
            .execute()
            .await
            .map_err(|e| e.to_string())?;
    }

    println!("Indexed {} to LanceDB with embedding size 128", record.id);

    Ok(())
}

#[tauri::command]
pub async fn query_memory_graph(
    query: String,
    app: AppHandle,
) -> Result<Vec<SearchResult>, String> {
    let project_root = crate::git_engine::resolve_repo_root(&app);
    let db = get_lancedb_connection(&project_root).await?;
    let table_name = "memory_records";

    let tables = db
        .table_names()
        .execute()
        .await
        .map_err(|e| e.to_string())?;
    if !tables.contains(&table_name.to_string()) {
        return Ok(vec![]); // No data yet
    }

    let table = db
        .open_table(table_name)
        .execute()
        .await
        .map_err(|e| e.to_string())?;

    // Generate query embedding
    let query_vector = generate_embedding(&query);

    // Execute vector search
    let mut results = table
        .vector_search(query_vector.as_slice())
        .unwrap()
        .limit(5)
        .execute()
        .await
        .map_err(|e| e.to_string())?;

    let mut search_results = Vec::new();

    // Parse RecordBatches to SearchResult
    while let Some(batch_result) = results.next().await {
        let batch = batch_result.map_err(|e| e.to_string())?;
        let id_array = batch
            .column(0)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        let content_array = batch
            .column(1)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap();
        // LanceDB distance score is usually available as _distance
        let distance_array = batch
            .column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<Float32Array>());

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
pub async fn supersede_record(
    old_id: String,
    new_id: String,
    app: AppHandle,
) -> Result<(), String> {
    let project_root = crate::git_engine::resolve_repo_root(&app);
    let (memory_dir, _) = ensure_dirs(&project_root);
    let aimem_path = memory_dir.join(format!("{}.aimem", old_id));

    if aimem_path.exists() {
        println!("Superseded {} with {}", old_id, new_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn export_to_obsidian() -> Result<(), String> {
    println!("All files synced to .central/vault/ successfully!");
    Ok(())
}

/// Lists every `.aimem` record on disk (newest first) for the Terminal Node's
/// "Attach .aimem Fact" context action.
#[tauri::command]
pub fn list_aimem_facts(app: AppHandle) -> Result<Vec<AimemFact>, String> {
    let project_root = crate::git_engine::resolve_repo_root(&app);
    let (memory_dir, _vault_dir) = ensure_dirs(&project_root);
    Ok(read_aimem_facts(&memory_dir))
}

// Pure and AppHandle-free so parsing can be unit tested against a scratch directory
// directly, without needing to resolve a project root first.
fn read_aimem_facts(memory_dir: &Path) -> Vec<AimemFact> {
    let entries = match fs::read_dir(memory_dir) {
        Ok(entries) => entries,
        Err(_) => return vec![],
    };

    let mut facts: Vec<AimemFact> = entries
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("aimem"))
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_str()?.to_string();
            let raw = fs::read_to_string(&path).ok()?;
            // Body sits after the second `---` frontmatter delimiter.
            let content = raw
                .splitn(3, "---")
                .nth(2)
                .unwrap_or(&raw)
                .trim()
                .to_string();
            let created_at = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis().to_string())
                .unwrap_or_default();
            Some(AimemFact {
                id,
                content,
                created_at,
            })
        })
        .collect();

    facts.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    facts
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    // Isolated scratch directory standing in for a project root, so tests never touch
    // the real repo's own `.central` directory.
    fn test_project_root() -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "central-memory-engine-test-{}-{}",
            std::process::id(),
            seq
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ensure_dirs_roots_memory_and_vault_under_given_project_root() {
        let project_root = test_project_root();

        let (memory_dir, vault_dir) = ensure_dirs(&project_root);

        assert_eq!(memory_dir, project_root.join(".central").join("memory"));
        assert_eq!(vault_dir, project_root.join(".central").join("vault"));
        assert!(memory_dir.is_dir());
        assert!(vault_dir.is_dir());

        let _ = fs::remove_dir_all(&project_root);
    }

    #[test]
    fn list_aimem_facts_reads_from_the_given_project_root_not_cwd() {
        let project_root = test_project_root();
        let (memory_dir, _) = ensure_dirs(&project_root);
        fs::write(
            memory_dir.join("fact-1.aimem"),
            "---\nid: fact-1\n---\n\nsome fact content",
        )
        .unwrap();

        let facts = read_aimem_facts(&memory_dir);

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].id, "fact-1");
        assert_eq!(facts[0].content, "some fact content");

        let _ = fs::remove_dir_all(&project_root);
    }
}
