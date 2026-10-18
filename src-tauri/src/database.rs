use serde::{Deserialize, Serialize};
use sqlx::{mysql::MySqlPool, postgres::PgPool, Column, Row, TypeInfo};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub enum DatabasePool {
    Mysql(MySqlPool),
    Postgres(PgPool),
}

pub struct DatabaseState {
    pub pools: Mutex<HashMap<String, DatabasePool>>,
}

impl DatabaseState {
    pub fn new() -> Self {
        Self {
            pools: Mutex::new(HashMap::new()),
        }
    }
}

/// Helper: get a clone of the pool from state (releases the MutexGuard before any .await)
fn get_pool(state: &DatabaseState, connection_id: &str) -> Result<DatabasePool, String> {
    let pools = state.pools.lock().map_err(|e| e.to_string())?;
    pools
        .get(connection_id)
        .cloned()
        .ok_or_else(|| "Not connected".to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_time_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
}

const MAX_ROWS: i64 = 10_000;
const QUERY_TIMEOUT_SECS: u64 = 30;

fn build_connection_url(
    db_type: &str,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    database: &str,
) -> String {
    let encoded_password = urlencoding::encode(password);
    match db_type {
        "mysql" => format!(
            "mysql://{}:{}@{}:{}/{}",
            username, encoded_password, host, port, database
        ),
        "postgres" => format!(
            "postgres://{}:{}@{}:{}/{}",
            username, encoded_password, host, port, database
        ),
        _ => String::new(),
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_test_connection(
    db_type: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: String,
) -> Result<String, String> {
    let url = build_connection_url(&db_type, &host, port, &username, &password, &database);
    let timeout = std::time::Duration::from_secs(10);

    match db_type.as_str() {
        "mysql" => {
            let pool = tokio::time::timeout(timeout, MySqlPool::connect(&url))
                .await
                .map_err(|_| "Connection timeout (10s)".to_string())?
                .map_err(|e| format!("MySQL connection failed: {}", e))?;
            let row: (String,) = sqlx::query_as("SELECT VERSION()")
                .fetch_one(&pool)
                .await
                .map_err(|e| format!("Query failed: {}", e))?;
            pool.close().await;
            Ok(format!("MySQL {}", row.0))
        }
        "postgres" => {
            let pool = tokio::time::timeout(timeout, PgPool::connect(&url))
                .await
                .map_err(|_| "Connection timeout (10s)".to_string())?
                .map_err(|e| format!("PostgreSQL connection failed: {}", e))?;
            let row: (String,) = sqlx::query_as("SELECT version()")
                .fetch_one(&pool)
                .await
                .map_err(|e| format!("Query failed: {}", e))?;
            pool.close().await;
            Ok(row.0)
        }
        _ => Err(format!("Unsupported database type: {}", db_type)),
    }
}

#[tauri::command]
pub async fn db_connect(
    state: tauri::State<'_, DatabaseState>,
    connection_id: String,
    db_type: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: String,
) -> Result<(), String> {
    let url = build_connection_url(&db_type, &host, port, &username, &password, &database);

    let pool = match db_type.as_str() {
        "mysql" => {
            let pool = sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(5)
                .acquire_timeout(std::time::Duration::from_secs(10))
                .connect(&url)
                .await
                .map_err(|e| format!("MySQL connection failed: {}", e))?;
            DatabasePool::Mysql(pool)
        }
        "postgres" => {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(5)
                .acquire_timeout(std::time::Duration::from_secs(10))
                .connect(&url)
                .await
                .map_err(|e| format!("PostgreSQL connection failed: {}", e))?;
            DatabasePool::Postgres(pool)
        }
        _ => return Err(format!("Unsupported database type: {}", db_type)),
    };

    let mut pools = state.pools.lock().map_err(|e| e.to_string())?;
    pools.insert(connection_id, pool);
    Ok(())
}

#[tauri::command]
pub async fn db_disconnect(
    state: tauri::State<'_, DatabaseState>,
    connection_id: String,
) -> Result<(), String> {
    let pool = {
        let mut pools = state.pools.lock().map_err(|e| e.to_string())?;
        pools.remove(&connection_id)
    };
    if let Some(pool) = pool {
        match pool {
            DatabasePool::Mysql(p) => p.close().await,
            DatabasePool::Postgres(p) => p.close().await,
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn db_list_databases(
    state: tauri::State<'_, DatabaseState>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    let pool = get_pool(&state, &connection_id)?;

    match &pool {
        DatabasePool::Mysql(p) => {
            let rows: Vec<(String,)> = sqlx::query_as("SHOW DATABASES")
                .fetch_all(p)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows.into_iter().map(|r| r.0).collect())
        }
        DatabasePool::Postgres(p) => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
            )
            .fetch_all(p)
            .await
            .map_err(|e| e.to_string())?;
            Ok(rows.into_iter().map(|r| r.0).collect())
        }
    }
}

#[tauri::command]
pub async fn db_list_tables(
    state: tauri::State<'_, DatabaseState>,
    connection_id: String,
    database: Option<String>,
) -> Result<Vec<String>, String> {
    let pool = get_pool(&state, &connection_id)?;

    match &pool {
        DatabasePool::Mysql(p) => {
            let query = if let Some(db) = &database {
                format!("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '{}' ORDER BY TABLE_NAME", db.replace('\'', "''"))
            } else {
                "SHOW TABLES".to_string()
            };
            let rows = sqlx::query(&query)
                .fetch_all(p)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows
                .iter()
                .map(|r| {
                    let val: String = r.get(0);
                    val
                })
                .collect())
        }
        DatabasePool::Postgres(p) => {
            let schema = "public";
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
            )
            .bind(schema)
            .fetch_all(p)
            .await
            .map_err(|e| e.to_string())?;
            Ok(rows.into_iter().map(|r| r.0).collect())
        }
    }
}

#[tauri::command]
pub async fn db_describe_table(
    state: tauri::State<'_, DatabaseState>,
    connection_id: String,
    table: String,
    database: Option<String>,
) -> Result<Vec<ColumnInfo>, String> {
    let pool = get_pool(&state, &connection_id)?;

    match &pool {
        DatabasePool::Mysql(p) => {
            let db_clause = if let Some(db) = &database {
                format!("AND c.TABLE_SCHEMA = '{}'", db.replace('\'', "''"))
            } else {
                String::new()
            };
            let query = format!(
                r#"SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
                   CASE WHEN c.COLUMN_KEY = 'PRI' THEN 1 ELSE 0 END as is_pk
                   FROM information_schema.COLUMNS c
                   WHERE c.TABLE_NAME = '{}' {}
                   ORDER BY c.ORDINAL_POSITION"#,
                table.replace('\'', "''"),
                db_clause
            );
            let rows = sqlx::query(&query)
                .fetch_all(p)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows
                .iter()
                .map(|r| ColumnInfo {
                    name: r.get::<String, _>(0),
                    data_type: r.get::<String, _>(1),
                    is_nullable: r.get::<String, _>(2) == "YES",
                    column_default: r.get::<Option<String>, _>(3),
                    is_primary_key: r.get::<i32, _>(4) == 1,
                })
                .collect())
        }
        DatabasePool::Postgres(p) => {
            let rows = sqlx::query(
                r#"SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                   CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END as is_pk
                   FROM information_schema.columns c
                   LEFT JOIN information_schema.key_column_usage kcu
                     ON c.table_name = kcu.table_name AND c.column_name = kcu.column_name
                   LEFT JOIN information_schema.table_constraints tc
                     ON kcu.constraint_name = tc.constraint_name AND tc.constraint_type = 'PRIMARY KEY'
                   WHERE c.table_name = $1 AND c.table_schema = 'public'
                   ORDER BY c.ordinal_position"#
            )
                .bind(&table)
                .fetch_all(p)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows
                .iter()
                .map(|r| ColumnInfo {
                    name: r.get::<String, _>(0),
                    data_type: r.get::<String, _>(1),
                    is_nullable: r.get::<String, _>(2) == "YES",
                    column_default: r.get::<Option<String>, _>(3),
                    is_primary_key: r.get::<bool, _>(4),
                })
                .collect())
        }
    }
}

#[tauri::command]
pub async fn db_execute_query(
    state: tauri::State<'_, DatabaseState>,
    connection_id: String,
    query: String,
) -> Result<QueryResult, String> {
    let pool = get_pool(&state, &connection_id)?;

    let trimmed = query.trim().to_uppercase();
    let is_select = trimmed.starts_with("SELECT")
        || trimmed.starts_with("SHOW")
        || trimmed.starts_with("DESCRIBE")
        || trimmed.starts_with("EXPLAIN");

    let start = Instant::now();
    let timeout = std::time::Duration::from_secs(QUERY_TIMEOUT_SECS);

    match &pool {
        DatabasePool::Mysql(p) => {
            if is_select {
                let limited_query = if !trimmed.contains("LIMIT") && trimmed.starts_with("SELECT") {
                    format!("{} LIMIT {}", query.trim_end_matches(';'), MAX_ROWS)
                } else {
                    query.clone()
                };
                let rows = tokio::time::timeout(timeout, sqlx::query(&limited_query).fetch_all(p))
                    .await
                    .map_err(|_| format!("Query timeout ({}s)", QUERY_TIMEOUT_SECS))?
                    .map_err(|e| e.to_string())?;

                let columns: Vec<String> = if let Some(first) = rows.first() {
                    first
                        .columns()
                        .iter()
                        .map(|c| c.name().to_string())
                        .collect()
                } else {
                    vec![]
                };

                let result_rows: Vec<Vec<serde_json::Value>> = rows
                    .iter()
                    .map(|row| {
                        row.columns()
                            .iter()
                            .enumerate()
                            .map(|(i, col)| mysql_value_to_json(row, i, col.type_info().name()))
                            .collect()
                    })
                    .collect();

                Ok(QueryResult {
                    columns,
                    rows: result_rows,
                    affected_rows: 0,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                })
            } else {
                let result = tokio::time::timeout(timeout, sqlx::query(&query).execute(p))
                    .await
                    .map_err(|_| format!("Query timeout ({}s)", QUERY_TIMEOUT_SECS))?
                    .map_err(|e| e.to_string())?;

                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected_rows: result.rows_affected(),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                })
            }
        }
        DatabasePool::Postgres(p) => {
            if is_select {
                let limited_query = if !trimmed.contains("LIMIT") && trimmed.starts_with("SELECT") {
                    format!("{} LIMIT {}", query.trim_end_matches(';'), MAX_ROWS)
                } else {
                    query.clone()
                };
                let rows = tokio::time::timeout(timeout, sqlx::query(&limited_query).fetch_all(p))
                    .await
                    .map_err(|_| format!("Query timeout ({}s)", QUERY_TIMEOUT_SECS))?
                    .map_err(|e| e.to_string())?;

                let columns: Vec<String> = if let Some(first) = rows.first() {
                    first
                        .columns()
                        .iter()
                        .map(|c| c.name().to_string())
                        .collect()
                } else {
                    vec![]
                };

                let result_rows: Vec<Vec<serde_json::Value>> = rows
                    .iter()
                    .map(|row| {
                        row.columns()
                            .iter()
                            .enumerate()
                            .map(|(i, col)| pg_value_to_json(row, i, col.type_info().name()))
                            .collect()
                    })
                    .collect();

                Ok(QueryResult {
                    columns,
                    rows: result_rows,
                    affected_rows: 0,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                })
            } else {
                let result = tokio::time::timeout(timeout, sqlx::query(&query).execute(p))
                    .await
                    .map_err(|_| format!("Query timeout ({}s)", QUERY_TIMEOUT_SECS))?
                    .map_err(|e| e.to_string())?;

                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected_rows: result.rows_affected(),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                })
            }
        }
    }
}

// ─── Value converters ────────────────────────────────────────────────────────

fn mysql_value_to_json(
    row: &sqlx::mysql::MySqlRow,
    idx: usize,
    type_name: &str,
) -> serde_json::Value {
    use sqlx::Row;
    match type_name {
        "BOOLEAN" | "TINYINT(1)" | "BOOL" => row
            .try_get::<bool, _>(idx)
            .map(serde_json::Value::Bool)
            .unwrap_or(serde_json::Value::Null),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" => row
            .try_get::<i32, _>(idx)
            .map(|v| serde_json::Value::Number(v.into()))
            .or_else(|_| {
                row.try_get::<i64, _>(idx)
                    .map(|v| serde_json::Value::Number(v.into()))
            })
            .unwrap_or(serde_json::Value::Null),
        "BIGINT" => row
            .try_get::<i64, _>(idx)
            .map(|v| serde_json::Value::Number(v.into()))
            .unwrap_or(serde_json::Value::Null),
        "FLOAT" | "DOUBLE" | "DECIMAL" => row
            .try_get::<f64, _>(idx)
            .ok()
            .and_then(|v| serde_json::Number::from_f64(v))
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        _ => row
            .try_get::<String, _>(idx)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    }
}

fn pg_value_to_json(row: &sqlx::postgres::PgRow, idx: usize, type_name: &str) -> serde_json::Value {
    use sqlx::Row;
    match type_name {
        "BOOL" => row
            .try_get::<bool, _>(idx)
            .map(serde_json::Value::Bool)
            .unwrap_or(serde_json::Value::Null),
        "INT2" | "INT4" => row
            .try_get::<i32, _>(idx)
            .map(|v| serde_json::Value::Number(v.into()))
            .unwrap_or(serde_json::Value::Null),
        "INT8" => row
            .try_get::<i64, _>(idx)
            .map(|v| serde_json::Value::Number(v.into()))
            .unwrap_or(serde_json::Value::Null),
        "FLOAT4" | "FLOAT8" | "NUMERIC" => row
            .try_get::<f64, _>(idx)
            .ok()
            .and_then(|v| serde_json::Number::from_f64(v))
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        "JSON" | "JSONB" => row
            .try_get::<serde_json::Value, _>(idx)
            .unwrap_or(serde_json::Value::Null),
        _ => row
            .try_get::<String, _>(idx)
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    }
}
