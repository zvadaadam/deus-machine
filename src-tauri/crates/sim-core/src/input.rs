/// Map touch type string to phase integer.
/// "began" -> 0, "moved" -> 1, "ended" -> 2.
/// Returns None for unknown phases.
pub fn map_touch_phase(touch_type: &str) -> Option<i32> {
    match touch_type {
        "began" => Some(0),
        "moved" => Some(1),
        "ended" => Some(2),
        _ => None,
    }
}

/// Map button type string to integer.
/// Only "home" (0) is supported. Returns None for unsupported types.
pub fn map_button_type(button_type: &str) -> Option<i32> {
    match button_type.to_lowercase().as_str() {
        "home" => Some(0),
        _ => None,
    }
}

/// Map direction string to integer.
/// "down" -> 0, "up" -> 1.
/// Returns None for unknown directions.
pub fn map_direction(direction: &str) -> Option<i32> {
    match direction.to_lowercase().as_str() {
        "down" => Some(0),
        "up" => Some(1),
        _ => None,
    }
}
