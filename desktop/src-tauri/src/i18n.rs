//! Launcher messages follow the system language, like the splash page does
//! (`navigator.language`): English for en-*, Chinese otherwise.

use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

/// Maps a locale tag such as `en_US.UTF-8`, `en-GB` or `zh_CN` to a launcher language.
pub fn lang_from_tag(tag: &str) -> Option<Lang> {
    let tag = tag.trim().to_ascii_lowercase();
    if tag.is_empty() || tag == "c" || tag == "posix" || tag.starts_with("c.") {
        return None;
    }
    Some(if tag.starts_with("en") { Lang::En } else { Lang::Zh })
}

#[cfg(windows)]
fn platform_lang() -> Option<Lang> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
    }
    // The primary language id is the low 10 bits; 0x09 is English.
    let id = unsafe { GetUserDefaultUILanguage() };
    Some(if id & 0x3ff == 0x09 { Lang::En } else { Lang::Zh })
}

#[cfg(target_os = "macos")]
fn platform_lang() -> Option<Lang> {
    // GUI apps usually start without LANG; ask for the first preferred language.
    let output = std::process::Command::new("defaults").args(["read", "-g", "AppleLanguages"]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.split(|c: char| c == '"' || c == ',' || c == '(' || c.is_whitespace()).find(|part| !part.is_empty())?;
    lang_from_tag(first)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_lang() -> Option<Lang> {
    None
}

fn env_lang() -> Option<Lang> {
    ["LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|name| std::env::var(name).ok().and_then(|value| lang_from_tag(&value)))
}

/// The system language, detected once.
pub fn lang() -> Lang {
    static LANG: OnceLock<Lang> = OnceLock::new();
    *LANG.get_or_init(|| platform_lang().or_else(env_lang).unwrap_or(Lang::Zh))
}

/// `tr!(lang; "中文 {x}", "English {x}")` or `tr!("中文", "English")` (system language); returns a `String`.
#[macro_export]
macro_rules! tr {
    ($lang:expr; $zh:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        match $lang {
            $crate::i18n::Lang::En => format!($en $(, $arg)*),
            $crate::i18n::Lang::Zh => format!($zh $(, $arg)*),
        }
    };
    ($zh:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        $crate::tr!($crate::i18n::lang(); $zh, $en $(, $arg)*)
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_map_to_languages() {
        assert_eq!(lang_from_tag("en_US.UTF-8"), Some(Lang::En));
        assert_eq!(lang_from_tag("en-GB"), Some(Lang::En));
        assert_eq!(lang_from_tag("zh_CN.UTF-8"), Some(Lang::Zh));
        assert_eq!(lang_from_tag("ja_JP"), Some(Lang::Zh));
        assert_eq!(lang_from_tag("C"), None);
        assert_eq!(lang_from_tag("C.UTF-8"), None);
        assert_eq!(lang_from_tag(""), None);
    }

    #[test]
    fn tr_picks_the_requested_language() {
        let port = 1;
        assert_eq!(tr!(Lang::En; "端口 {port}", "Port {port}"), "Port 1");
        assert_eq!(tr!(Lang::Zh; "端口 {port}", "Port {port}"), "端口 1");
    }
}
