use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use surrealdb::engine::local::Db;
use surrealdb::Surreal;

const TABLE_MY: &str = "skills_my";
const TABLE_GALLERY: &str = "skills_gallery";
const META_KEY_GALLERY_SEED: &str = "skills_gallery_seed_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPayload {
    pub id: String,
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub command: String,
    pub cli_type: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub built_in: bool,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub when_to_use: Option<String>,
    #[serde(default)]
    pub disable_model_invocation: bool,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub priority: Option<f64>,
    #[serde(default)]
    pub original_name: Option<String>,
    #[serde(default)]
    pub original_command: Option<String>,
    #[serde(default)]
    pub original_description: Option<String>,
    #[serde(default)]
    pub source_pack: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub safety_level: Option<String>,
    #[serde(default)]
    pub safety_reasons: Vec<String>,
    #[serde(default)]
    pub trust_level: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBootstrapResult {
    pub seeded_gallery: bool,
    pub my_count: usize,
    pub gallery_count: usize,
    pub gallery_seed: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDbStats {
    pub my_count: usize,
    pub my_builtin_count: usize,
    pub my_user_count: usize,
    pub gallery_count: usize,
    pub gallery_seed: Option<String>,
    pub installed_pack_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackMeta {
    pub pack_name: String,
    pub pack_version: String,
    pub source_url: Option<String>,
    pub checksum_sha256: Option<String>,
    pub installed_skill_count: usize,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackInstallResult {
    pub pack: SkillPackMeta,
    pub inserted_count: usize,
    pub skipped_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackRemoveResult {
    pub pack_name: String,
    pub removed_skill_count: usize,
    pub removed_pack_meta: bool,
}

pub async fn bootstrap(
    default_skills: Vec<SkillPayload>,
    gallery_skills: Vec<SkillPayload>,
    gallery_seed: String,
) -> Result<SkillBootstrapResult, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;

    let defaults = sanitize_skills(default_skills, true);
    let gallery = sanitize_skills(gallery_skills, false);

    let existing_my = read_skill_table(&db, TABLE_MY).await?;
    let mut existing_by_id: HashMap<String, SkillPayload> = HashMap::new();
    for skill in &existing_my {
        existing_by_id.insert(skill.id.clone(), skill.clone());
    }

    let mut merged_my: Vec<SkillPayload> = Vec::new();
    for def in defaults {
        let def_id = def.id.clone();
        let merged = merge_builtin(def, existing_by_id.get(&def_id));
        merged_my.push(merged);
    }

    let default_id_set: HashSet<String> = merged_my.iter().map(|s| s.id.clone()).collect();
    for skill in existing_my {
        if skill.built_in {
            continue;
        }
        if default_id_set.contains(&skill.id) {
            continue;
        }
        merged_my.push(skill);
    }

    write_skill_table(&db, TABLE_MY, &merged_my).await?;

    let prev_seed = get_meta_value(&db, META_KEY_GALLERY_SEED).await?;
    let seeded_gallery = prev_seed.as_deref() != Some(gallery_seed.as_str());
    if seeded_gallery && gallery.is_empty() {
        return Err("Skills DB seed mismatch: no gallery data provided".to_string());
    }
    let gallery_count = if seeded_gallery {
        write_skill_table(&db, TABLE_GALLERY, &gallery).await?;
        set_meta_value(&db, META_KEY_GALLERY_SEED, &gallery_seed).await?;
        gallery.len()
    } else {
        read_skill_table(&db, TABLE_GALLERY).await?.len()
    };

    Ok(SkillBootstrapResult {
        seeded_gallery,
        my_count: merged_my.len(),
        gallery_count,
        gallery_seed,
    })
}

pub async fn list_my() -> Result<Vec<SkillPayload>, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;
    let mut rows = read_skill_table(&db, TABLE_MY).await?;
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(rows)
}

pub async fn list_gallery() -> Result<Vec<SkillPayload>, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;
    read_skill_table(&db, TABLE_GALLERY).await
}

pub async fn set_my(skills: Vec<SkillPayload>) -> Result<usize, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;
    let normalized = sanitize_skills(skills, false);
    write_skill_table(&db, TABLE_MY, &normalized).await?;
    Ok(normalized.len())
}

pub async fn upsert_my(skill: SkillPayload) -> Result<SkillPayload, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;

    let Some(mut normalized) = sanitize_skill(skill, false) else {
        return Err("Invalid skill payload".to_string());
    };

    if let Some(existing) = read_my_by_id(&db, &normalized.id).await? {
        if existing.built_in {
            normalized.built_in = true;
        }
    }

    let payload = serde_json::to_value(&normalized)
        .map_err(|e| format!("Skills DB serialize failed: {e}"))?;
    db.query("DELETE skills_my WHERE skill_id = $skill_id")
        .bind(("skill_id", normalized.id.clone()))
        .await
        .map_err(|e| format!("Skills DB upsert delete failed: {e}"))?;
    db.query("CREATE skills_my CONTENT { skill_id: $skill_id, payload: $payload, updated_at: time::now() }")
        .bind(("skill_id", normalized.id.clone()))
        .bind(("payload", payload))
        .await
        .map_err(|e| format!("Skills DB upsert insert failed: {e}"))?;

    Ok(normalized)
}

pub async fn delete_my(skill_id: String) -> Result<bool, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;

    let id = skill_id.trim().to_string();
    if id.is_empty() {
        return Ok(false);
    }

    let Some(existing) = read_my_by_id(&db, &id).await? else {
        return Ok(false);
    };
    if existing.built_in {
        return Ok(false);
    }

    db.query("DELETE skills_my WHERE skill_id = $skill_id")
        .bind(("skill_id", id))
        .await
        .map_err(|e| format!("Skills DB delete failed: {e}"))?;
    Ok(true)
}

pub async fn stats() -> Result<SkillDbStats, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;

    let my = read_skill_table(&db, TABLE_MY).await?;
    let gallery = read_skill_table(&db, TABLE_GALLERY).await?;
    let built_in = my.iter().filter(|s| s.built_in).count();
    let seed = get_meta_value(&db, META_KEY_GALLERY_SEED).await?;
    let packs = read_pack_table(&db).await?;

    Ok(SkillDbStats {
        my_count: my.len(),
        my_builtin_count: built_in,
        my_user_count: my.len().saturating_sub(built_in),
        gallery_count: gallery.len(),
        gallery_seed: seed,
        installed_pack_count: packs.len(),
    })
}

pub async fn list_packs() -> Result<Vec<SkillPackMeta>, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;
    let mut packs = read_pack_table(&db).await?;
    packs.sort_by(|a, b| a.pack_name.cmp(&b.pack_name));
    Ok(packs)
}

pub async fn install_pack(
    pack_name: String,
    pack_version: String,
    source_url: Option<String>,
    checksum_sha256: Option<String>,
    skills: Vec<SkillPayload>,
    replace_existing: Option<bool>,
) -> Result<SkillPackInstallResult, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;

    let pack_name = pack_name.trim().to_string();
    let pack_version = pack_version.trim().to_string();
    if pack_name.is_empty() {
        return Err("pack_name is required".to_string());
    }
    if pack_version.is_empty() {
        return Err("pack_version is required".to_string());
    }

    let mut normalized = sanitize_skills(skills, false);
    if normalized.is_empty() {
        return Err("skills is empty".to_string());
    }
    for skill in &mut normalized {
        skill.source_pack = Some(pack_name.clone());
    }

    // Remove old rows from the same pack first (upgrade behavior).
    let _ = db
        .query("DELETE skills_gallery WHERE payload.sourcePack = $pack_name")
        .bind(("pack_name", pack_name.clone()))
        .await
        .map_err(|e| format!("Skills DB clear old pack rows failed: {e}"))?;

    let replace = replace_existing.unwrap_or(true);
    let existing_ids: HashSet<String> = if replace {
        HashSet::new()
    } else {
        read_skill_table(&db, TABLE_GALLERY)
            .await?
            .into_iter()
            .map(|s| s.id)
            .collect()
    };

    let mut inserted_count = 0usize;
    let mut skipped_count = 0usize;
    for skill in normalized {
        if !replace && existing_ids.contains(&skill.id) {
            skipped_count += 1;
            continue;
        }
        upsert_skill_row(&db, TABLE_GALLERY, &skill).await?;
        inserted_count += 1;
    }

    let pack = SkillPackMeta {
        pack_name: pack_name.clone(),
        pack_version,
        source_url: source_url.filter(|s| !s.trim().is_empty()),
        checksum_sha256: checksum_sha256.filter(|s| !s.trim().is_empty()),
        installed_skill_count: inserted_count,
        installed_at: crate::db::now_iso8601(),
    };
    upsert_pack_row(&db, &pack).await?;

    Ok(SkillPackInstallResult {
        pack,
        inserted_count,
        skipped_count,
    })
}

pub async fn remove_pack(pack_name: String) -> Result<SkillPackRemoveResult, String> {
    let db = ensure_db_ready().await?;
    ensure_schema(&db).await?;

    let pack_name = pack_name.trim().to_string();
    if pack_name.is_empty() {
        return Err("pack_name is required".to_string());
    }

    let mut count_result = db
        .query("SELECT count() AS c FROM skills_gallery WHERE payload.sourcePack = $pack_name GROUP ALL")
        .bind(("pack_name", pack_name.clone()))
        .await
        .map_err(|e| format!("Skills DB remove pack count failed: {e}"))?;
    let count_rows: Vec<Value> = count_result
        .take(0)
        .map_err(|e| format!("Skills DB remove pack parse failed: {e}"))?;
    let removed_skill_count = count_rows
        .first()
        .and_then(|v| v.get("c"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;

    db.query("DELETE skills_gallery WHERE payload.sourcePack = $pack_name")
        .bind(("pack_name", pack_name.clone()))
        .await
        .map_err(|e| format!("Skills DB remove pack rows failed: {e}"))?;

    let mut meta_result = db
        .query("SELECT count() AS c FROM skills_pack WHERE packName = $pack_name OR pack_name = $pack_name GROUP ALL")
        .bind(("pack_name", pack_name.clone()))
        .await
        .map_err(|e| format!("Skills DB remove pack meta count failed: {e}"))?;
    let meta_rows: Vec<Value> = meta_result
        .take(0)
        .map_err(|e| format!("Skills DB remove pack meta parse failed: {e}"))?;
    let has_meta = meta_rows
        .first()
        .and_then(|v| v.get("c"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        > 0;

    db.query("DELETE skills_pack WHERE packName = $pack_name OR pack_name = $pack_name")
        .bind(("pack_name", pack_name.clone()))
        .await
        .map_err(|e| format!("Skills DB remove pack meta failed: {e}"))?;

    Ok(SkillPackRemoveResult {
        pack_name,
        removed_skill_count,
        removed_pack_meta: has_meta,
    })
}

async fn ensure_db_ready() -> Result<std::sync::Arc<Surreal<Db>>, String> {
    if let Ok(db) = crate::db::get_db() {
        return Ok(db);
    }
    match crate::db::init_db().await {
        Ok(db) => Ok(db),
        Err(err) => {
            if err.contains("already initialized") {
                crate::db::get_db()
            } else {
                Err(err)
            }
        }
    }
}

async fn ensure_schema(db: &Surreal<Db>) -> Result<(), String> {
    db.query(
        r#"
        DEFINE TABLE IF NOT EXISTS skills_my SCHEMALESS;
        DEFINE FIELD IF NOT EXISTS skill_id ON skills_my TYPE string;
        DEFINE FIELD IF NOT EXISTS payload ON skills_my TYPE object;
        DEFINE INDEX IF NOT EXISTS idx_skills_my_skill_id ON skills_my FIELDS skill_id UNIQUE;

        DEFINE TABLE IF NOT EXISTS skills_gallery SCHEMALESS;
        DEFINE FIELD IF NOT EXISTS skill_id ON skills_gallery TYPE string;
        DEFINE FIELD IF NOT EXISTS payload ON skills_gallery TYPE object;
        DEFINE INDEX IF NOT EXISTS idx_skills_gallery_skill_id ON skills_gallery FIELDS skill_id UNIQUE;

        DEFINE TABLE IF NOT EXISTS skills_meta SCHEMALESS;
        DEFINE FIELD IF NOT EXISTS mkey ON skills_meta TYPE string;
        DEFINE FIELD IF NOT EXISTS mvalue ON skills_meta TYPE string;
        DEFINE INDEX IF NOT EXISTS idx_skills_meta_key ON skills_meta FIELDS mkey UNIQUE;

        DEFINE TABLE IF NOT EXISTS skills_pack SCHEMALESS;
        DEFINE FIELD IF NOT EXISTS packName ON skills_pack TYPE string;
        DEFINE FIELD IF NOT EXISTS packVersion ON skills_pack TYPE string;
        DEFINE FIELD IF NOT EXISTS sourceUrl ON skills_pack TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS checksumSha256 ON skills_pack TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS installedSkillCount ON skills_pack TYPE int;
        DEFINE FIELD IF NOT EXISTS installedAt ON skills_pack TYPE string;
        DEFINE INDEX IF NOT EXISTS idx_skills_pack_name ON skills_pack FIELDS packName UNIQUE;
        "#,
    )
    .await
    .map_err(|e| format!("Skills DB schema setup failed: {e}"))?;
    Ok(())
}

fn sanitize_skills(skills: Vec<SkillPayload>, force_builtin: bool) -> Vec<SkillPayload> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for mut skill in skills {
        skill.id = skill.id.trim().to_string();
        if skill.id.is_empty() {
            continue;
        }
        if seen.contains(&skill.id) {
            continue;
        }
        skill.name = skill.name.trim().to_string();
        skill.description = skill.description.trim().to_string();
        skill.emoji = if skill.emoji.trim().is_empty() {
            "⚡".to_string()
        } else {
            skill.emoji.trim().to_string()
        };
        skill.command = skill.command.trim().to_string();
        skill.cli_type = if skill.cli_type.trim().is_empty() {
            "shell".to_string()
        } else {
            skill.cli_type.trim().to_string()
        };
        skill.category = if skill.category.trim().is_empty() {
            "custom".to_string()
        } else {
            skill.category.trim().to_string()
        };
        skill.tags = skill
            .tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        skill.allowed_tools = skill
            .allowed_tools
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        skill.paths = skill
            .paths
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        skill.safety_reasons = skill
            .safety_reasons
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        skill.when_to_use = skill.when_to_use.and_then(|v| {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        });
        skill.source_pack = skill.source_pack.and_then(|v| {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        });
        skill.source_url = skill.source_url.and_then(|v| {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        });
        skill.safety_level = skill.safety_level.and_then(|v| {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        });
        skill.trust_level = skill.trust_level.and_then(|v| {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        });
        if force_builtin {
            skill.built_in = true;
        }
        seen.insert(skill.id.clone());
        out.push(skill);
    }
    out
}

fn sanitize_skill(mut skill: SkillPayload, force_builtin: bool) -> Option<SkillPayload> {
    skill.id = skill.id.trim().to_string();
    if skill.id.is_empty() {
        return None;
    }
    skill.name = skill.name.trim().to_string();
    skill.description = skill.description.trim().to_string();
    skill.emoji = if skill.emoji.trim().is_empty() {
        "⚡".to_string()
    } else {
        skill.emoji.trim().to_string()
    };
    skill.command = skill.command.trim().to_string();
    skill.cli_type = if skill.cli_type.trim().is_empty() {
        "shell".to_string()
    } else {
        skill.cli_type.trim().to_string()
    };
    skill.category = if skill.category.trim().is_empty() {
        "custom".to_string()
    } else {
        skill.category.trim().to_string()
    };
    skill.tags = skill
        .tags
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    skill.allowed_tools = skill
        .allowed_tools
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    skill.paths = skill
        .paths
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    skill.safety_reasons = skill
        .safety_reasons
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    skill.when_to_use = skill.when_to_use.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    });
    skill.source_pack = skill.source_pack.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    });
    skill.source_url = skill.source_url.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    });
    skill.safety_level = skill.safety_level.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    });
    skill.trust_level = skill.trust_level.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    });
    if force_builtin {
        skill.built_in = true;
    }
    Some(skill)
}

fn merge_builtin(default_skill: SkillPayload, saved: Option<&SkillPayload>) -> SkillPayload {
    let Some(saved_skill) = saved else {
        return default_skill;
    };

    let mut merged_value = match serde_json::to_value(&default_skill) {
        Ok(v) => v,
        Err(_) => return default_skill,
    };
    let saved_value = match serde_json::to_value(saved_skill) {
        Ok(v) => v,
        Err(_) => return default_skill,
    };

    if let (Value::Object(merged_obj), Value::Object(saved_obj)) = (&mut merged_value, saved_value)
    {
        for (k, v) in saved_obj {
            merged_obj.insert(k, v);
        }
        merged_obj.insert("id".to_string(), Value::String(default_skill.id.clone()));
        merged_obj.insert("builtIn".to_string(), Value::Bool(true));
    }

    match serde_json::from_value::<SkillPayload>(merged_value) {
        Ok(skill) => skill,
        Err(_) => default_skill,
    }
}

async fn read_skill_table(db: &Surreal<Db>, table: &str) -> Result<Vec<SkillPayload>, String> {
    let query = match table {
        TABLE_MY => "SELECT payload FROM skills_my",
        TABLE_GALLERY => "SELECT payload FROM skills_gallery",
        _ => return Err(format!("Unsupported skill table: {table}")),
    };
    let mut result = db
        .query(query)
        .await
        .map_err(|e| format!("Skills DB query failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Skills DB parse failed: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(payload) = row.get("payload").cloned() {
            if let Ok(skill) = serde_json::from_value::<SkillPayload>(payload) {
                out.push(skill);
            }
        }
    }
    Ok(out)
}

async fn read_my_by_id(db: &Surreal<Db>, skill_id: &str) -> Result<Option<SkillPayload>, String> {
    let mut result = db
        .query("SELECT payload FROM skills_my WHERE skill_id = $skill_id LIMIT 1")
        .bind(("skill_id", skill_id.to_string()))
        .await
        .map_err(|e| format!("Skills DB query by id failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Skills DB parse by id failed: {e}"))?;
    let skill = rows
        .into_iter()
        .next()
        .and_then(|r| r.get("payload").cloned())
        .and_then(|v| serde_json::from_value::<SkillPayload>(v).ok());
    Ok(skill)
}

async fn write_skill_table(
    db: &Surreal<Db>,
    table: &str,
    skills: &[SkillPayload],
) -> Result<(), String> {
    let (delete_query, create_query) = match table {
        TABLE_MY => (
            "DELETE skills_my",
            "CREATE skills_my CONTENT { skill_id: $skill_id, payload: $payload, updated_at: time::now() }",
        ),
        TABLE_GALLERY => (
            "DELETE skills_gallery",
            "CREATE skills_gallery CONTENT { skill_id: $skill_id, payload: $payload, updated_at: time::now() }",
        ),
        _ => return Err(format!("Unsupported skill table: {table}")),
    };

    db.query(delete_query)
        .await
        .map_err(|e| format!("Skills DB clear failed: {e}"))?;

    for skill in skills {
        // Full-table write path: delete then insert.
        let payload =
            serde_json::to_value(skill).map_err(|e| format!("Skills DB serialize failed: {e}"))?;
        db.query(create_query)
            .bind(("skill_id", skill.id.clone()))
            .bind(("payload", payload))
            .await
            .map_err(|e| format!("Skills DB insert failed: {e}"))?;
    }
    Ok(())
}

async fn upsert_skill_row(
    db: &Surreal<Db>,
    table: &str,
    skill: &SkillPayload,
) -> Result<(), String> {
    let (delete_query, create_query) = match table {
        TABLE_MY => (
            "DELETE skills_my WHERE skill_id = $skill_id",
            "CREATE skills_my CONTENT { skill_id: $skill_id, payload: $payload, updated_at: time::now() }",
        ),
        TABLE_GALLERY => (
            "DELETE skills_gallery WHERE skill_id = $skill_id",
            "CREATE skills_gallery CONTENT { skill_id: $skill_id, payload: $payload, updated_at: time::now() }",
        ),
        _ => return Err(format!("Unsupported upsert table: {table}")),
    };

    let payload =
        serde_json::to_value(skill).map_err(|e| format!("Skills DB serialize failed: {e}"))?;
    db.query(delete_query)
        .bind(("skill_id", skill.id.clone()))
        .await
        .map_err(|e| format!("Skills DB upsert delete failed: {e}"))?;
    db.query(create_query)
        .bind(("skill_id", skill.id.clone()))
        .bind(("payload", payload))
        .await
        .map_err(|e| format!("Skills DB upsert insert failed: {e}"))?;
    Ok(())
}

async fn read_pack_table(db: &Surreal<Db>) -> Result<Vec<SkillPackMeta>, String> {
    let mut result = db
        .query("SELECT * FROM skills_pack")
        .await
        .map_err(|e| format!("Skills DB list packs failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Skills DB parse packs failed: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        if let Ok(pack) = serde_json::from_value::<SkillPackMeta>(row.clone()) {
            out.push(pack);
            continue;
        }
        if let Value::Object(mut obj) = row {
            // Backward compatibility for earlier snake_case rows.
            if let Some(v) = obj.get("pack_name").cloned() {
                obj.insert("packName".to_string(), v);
            }
            if let Some(v) = obj.get("pack_version").cloned() {
                obj.insert("packVersion".to_string(), v);
            }
            if let Some(v) = obj.get("source_url").cloned() {
                obj.insert("sourceUrl".to_string(), v);
            }
            if let Some(v) = obj.get("checksum_sha256").cloned() {
                obj.insert("checksumSha256".to_string(), v);
            }
            if let Some(v) = obj.get("installed_skill_count").cloned() {
                obj.insert("installedSkillCount".to_string(), v);
            }
            if let Some(v) = obj.get("installed_at").cloned() {
                obj.insert("installedAt".to_string(), v);
            }
            if let Ok(pack) = serde_json::from_value::<SkillPackMeta>(Value::Object(obj)) {
                out.push(pack);
            }
        }
    }
    Ok(out)
}

async fn upsert_pack_row(db: &Surreal<Db>, pack: &SkillPackMeta) -> Result<(), String> {
    db.query("DELETE skills_pack WHERE packName = $pack_name OR pack_name = $pack_name")
        .bind(("pack_name", pack.pack_name.clone()))
        .await
        .map_err(|e| format!("Skills DB upsert pack delete failed: {e}"))?;
    db.query(
        "CREATE skills_pack CONTENT { \
            packName: $pack_name, \
            packVersion: $pack_version, \
            sourceUrl: $source_url, \
            checksumSha256: $checksum_sha256, \
            installedSkillCount: $installed_skill_count, \
            installedAt: $installed_at \
         }",
    )
    .bind(("pack_name", pack.pack_name.clone()))
    .bind(("pack_version", pack.pack_version.clone()))
    .bind(("source_url", pack.source_url.clone()))
    .bind(("checksum_sha256", pack.checksum_sha256.clone()))
    .bind(("installed_skill_count", pack.installed_skill_count as i64))
    .bind(("installed_at", pack.installed_at.clone()))
    .await
    .map_err(|e| format!("Skills DB upsert pack insert failed: {e}"))?;
    Ok(())
}

async fn get_meta_value(db: &Surreal<Db>, key: &str) -> Result<Option<String>, String> {
    let mut result = db
        .query("SELECT mvalue FROM skills_meta WHERE mkey = $mkey LIMIT 1")
        .bind(("mkey", key.to_string()))
        .await
        .map_err(|e| format!("Skills DB meta query failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Skills DB meta parse failed: {e}"))?;
    let value = rows
        .into_iter()
        .next()
        .and_then(|r| r.get("mvalue").cloned())
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(value)
}

async fn set_meta_value(db: &Surreal<Db>, key: &str, value: &str) -> Result<(), String> {
    db.query("DELETE skills_meta WHERE mkey = $mkey")
        .bind(("mkey", key.to_string()))
        .await
        .map_err(|e| format!("Skills DB meta delete failed: {e}"))?;
    db.query(
        "CREATE skills_meta CONTENT { mkey: $mkey, mvalue: $mvalue, updated_at: time::now() }",
    )
    .bind(("mkey", key.to_string()))
    .bind(("mvalue", value.to_string()))
    .await
    .map_err(|e| format!("Skills DB meta insert failed: {e}"))?;
    Ok(())
}
