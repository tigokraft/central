use lancedb::connection::Connection;
use arrow_array::{RecordBatch, RecordBatchIterator};
use std::sync::Arc;
pub async fn t(db: &Connection, b: RecordBatch, s: Arc<arrow_schema::Schema>) {
let reader = RecordBatchIterator::new(vec![Ok(b)], s);
db.create_table("t", Box::new(reader)).execute().await.unwrap();
}