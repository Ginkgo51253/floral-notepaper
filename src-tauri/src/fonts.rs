use crate::services::notes::AppError;
use std::collections::BTreeSet;

#[tauri::command]
pub fn system_fonts_list() -> Result<Vec<String>, AppError> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut families = BTreeSet::new();
    for face in db.faces() {
        for (name, _) in &face.families {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                families.insert(trimmed.to_string());
            }
        }
    }

    Ok(families.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_fonts_list_returns_sorted_unique_names() {
        let fonts = system_fonts_list().expect("load system fonts");
        assert!(!fonts.is_empty());
        let mut sorted = fonts.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(fonts, sorted);
    }
}
