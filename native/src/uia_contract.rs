//! Pointer-free, versioned UIA locator contract shared by worker and portable tests.
use super::*;
pub fn validate_selector(s: &Value) -> Result<()> {
    let fields = s.as_object().ok_or("uia:INVALID_REQUEST")?;
    if fields.is_empty() || fields.len() > 4 {
        return Err("uia:INVALID_REQUEST".into());
    }
    for (key, value) in fields {
        let text = value.as_str().ok_or("uia:INVALID_REQUEST")?;
        if text.chars().count() > 512 || (key != "name" && text.is_empty()) {
            return Err("uia:INVALID_REQUEST".into());
        }
        if key == "controlType" {
            if control_id(text).is_none() {
                return Err("uia:INVALID_REQUEST".into());
            }
        } else if !["automationId", "name", "className"].contains(&key.as_str()) {
            return Err("uia:INVALID_REQUEST".into());
        }
    }
    Ok(())
}
pub fn validate(locator: &Value) -> Result<()> {
    let fields = locator.as_object().ok_or("uia:INVALID_REQUEST")?;
    if locator["version"] != 1
        || locator["backend"] != "uia"
        || fields
            .keys()
            .any(|k| !["version", "backend", "selector", "ancestors"].contains(&k.as_str()))
    {
        return Err("uia:INVALID_REQUEST".into());
    }
    validate_selector(&locator["selector"])?;
    if let Some(ancestors) = locator.get("ancestors") {
        let ancestors = ancestors.as_array().ok_or("uia:INVALID_REQUEST")?;
        if ancestors.len() > 8 {
            return Err("uia:INVALID_REQUEST".into());
        }
        for selector in ancestors {
            validate_selector(selector)?;
        }
    }
    Ok(())
}
pub fn control_id(name: &str) -> Option<i32> {
    Some(match name {
        "button" => 50000,
        "checkbox" => 50002,
        "combobox" => 50003,
        "edit" => 50004,
        "listitem" => 50007,
        "list" => 50008,
        "menuitem" => 50011,
        "tab" => 50018,
        "tabitem" => 50019,
        "text" => 50020,
        "tree" => 50023,
        "treeitem" => 50024,
        "custom" => 50025,
        "window" => 50032,
        "pane" => 50033,
        _ => return None,
    })
}
pub fn control_name(id: i32) -> &'static str {
    [
        "button", "checkbox", "combobox", "edit", "listitem", "list", "menuitem", "tab", "tabitem",
        "text", "tree", "treeitem", "custom", "window", "pane",
    ]
    .into_iter()
    .find(|name| control_id(name) == Some(id))
    .unwrap_or("custom")
}
pub fn matches(selector: &Value, properties: &Value) -> bool {
    selector.as_object().is_some_and(|fields| {
        fields
            .iter()
            .all(|(key, value)| properties.get(key) == Some(value))
    })
}
pub fn action_guard(element: &Value, action: &str) -> Result<()> {
    if element["secure"] == true {
        return Err("uia:SECURE_ELEMENT".into());
    }
    if element["virtualized"] == true {
        return Err("uia:VIRTUALIZED_ELEMENT".into());
    }
    if element["offscreen"] == true {
        return Err("uia:ELEMENT_OFFSCREEN".into());
    }
    if action != "read" && element["enabled"] != true {
        return Err("uia:ELEMENT_DISABLED".into());
    }
    if !element["actions"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == action))
    {
        return Err("uia:UNSUPPORTED_PATTERN".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locators_reject_pointers_and_unbounded_paths() {
        let good = json!({"version":1,"backend":"uia","selector":{"automationId":"2","controlType":"edit"}});
        validate(&good).unwrap();
        for field in ["runtimeId", "pointer", "hwnd", "pid", "x"] {
            let mut bad = good.clone();
            bad["selector"][field] = json!(42);
            assert!(validate(&bad).is_err());
        }
        let mut bad = good.clone();
        bad["ancestors"] = json!(vec![json!({"name":"parent"}); 9]);
        assert!(validate(&bad).is_err());
        let mut bad = good;
        bad["selector"] = json!({});
        assert!(validate(&bad).is_err());
    }
    #[test]
    fn semantic_match_survives_movement_but_is_exact() {
        let selector = json!({"automationId":"2","controlType":"edit"});
        for x in [10, 400] {
            assert!(matches(
                &selector,
                &json!({"automationId":"2","controlType":"edit","bounds":{"x":x}})
            ));
        }
        assert!(!matches(
            &selector,
            &json!({"automationId":"20","controlType":"edit"})
        ));
    }
    #[test]
    fn action_policy_never_reads_secure_or_realizes_virtualized_controls() {
        let mut element = json!({"enabled":true,"secure":false,"offscreen":false,"virtualized":false,"actions":["read","invoke"]});
        action_guard(&element, "invoke").unwrap();
        element["secure"] = json!(true);
        assert_eq!(
            action_guard(&element, "read").unwrap_err(),
            "uia:SECURE_ELEMENT"
        );
        element["secure"] = json!(false);
        element["virtualized"] = json!(true);
        assert_eq!(
            action_guard(&element, "invoke").unwrap_err(),
            "uia:VIRTUALIZED_ELEMENT"
        );
        element["virtualized"] = json!(false);
        element["enabled"] = json!(false);
        assert_eq!(
            action_guard(&element, "invoke").unwrap_err(),
            "uia:ELEMENT_DISABLED"
        );
        action_guard(&element, "read").unwrap();
    }
}
