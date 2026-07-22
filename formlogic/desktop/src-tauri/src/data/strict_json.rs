//! Strict JSON parser for envelope validation (plan §12.2): the Desktop
//! primary must not trust Cloud parsing, and `serde_json` silently keeps the
//! LAST duplicate key — invisible dupes are exactly the smuggling vector the
//! E2EE plan closes with seld/jsonlint on the PHP side. This parser rejects:
//!
//! * duplicate keys at ANY nesting level;
//! * non-UTF-8 input and lone surrogates in `\u` escapes;
//! * numbers that don't fit `i64` (floats stay floats — the envelope
//!   validator rejects them where integers are required);
//! * leading zeros, bare `+`, trailing garbage, depth > 64, unescaped C0
//!   control characters.
//!
//! The accepted value is returned as a `serde_json::Value` so downstream code
//! shares one value model with [`super::canonical`].

use serde_json::{Map, Number, Value};

const MAX_DEPTH: usize = 64;

pub fn parse(input: &[u8]) -> Result<Value, String> {
    let text = std::str::from_utf8(input).map_err(|_| "input is not valid UTF-8".to_string())?;
    let mut p = Parser { chars: text.char_indices().peekable(), text };
    p.skip_ws();
    let value = p.parse_value(0)?;
    p.skip_ws();
    if p.chars.peek().is_some() {
        return Err("trailing characters after JSON value".into());
    }
    Ok(value)
}

struct Parser<'a> {
    chars: std::iter::Peekable<std::str::CharIndices<'a>>,
    text: &'a str,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while let Some((_, c)) = self.chars.peek() {
            if matches!(c, ' ' | '\t' | '\n' | '\r') {
                self.chars.next();
            } else {
                break;
            }
        }
    }

    fn next_char(&mut self) -> Result<char, String> {
        self.chars.next().map(|(_, c)| c).ok_or_else(|| "unexpected end of input".into())
    }

    fn expect_literal(&mut self, rest: &str, value: Value) -> Result<Value, String> {
        for expected in rest.chars() {
            if self.next_char()? != expected {
                return Err("invalid literal".into());
            }
        }
        Ok(value)
    }

    fn parse_value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return Err("nesting too deep".into());
        }
        let (_, c) = *self.chars.peek().ok_or("unexpected end of input")?;
        match c {
            '{' => self.parse_object(depth),
            '[' => self.parse_array(depth),
            '"' => Ok(Value::String(self.parse_string()?)),
            't' => {
                self.chars.next();
                self.expect_literal("rue", Value::Bool(true))
            }
            'f' => {
                self.chars.next();
                self.expect_literal("alse", Value::Bool(false))
            }
            'n' => {
                self.chars.next();
                self.expect_literal("ull", Value::Null)
            }
            '-' | '0'..='9' => self.parse_number(),
            _ => Err(format!("unexpected character {c:?}")),
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<Value, String> {
        self.chars.next(); // '{'
        let mut map = Map::new();
        self.skip_ws();
        if matches!(self.chars.peek(), Some((_, '}'))) {
            self.chars.next();
            return Ok(Value::Object(map));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string().map_err(|e| format!("object key: {e}"))?;
            if map.contains_key(&key) {
                return Err(format!("duplicate JSON key: {key}"));
            }
            self.skip_ws();
            if self.next_char()? != ':' {
                return Err("expected ':' after object key".into());
            }
            self.skip_ws();
            let value = self.parse_value(depth + 1)?;
            map.insert(key, value);
            self.skip_ws();
            match self.next_char()? {
                ',' => continue,
                '}' => return Ok(Value::Object(map)),
                other => return Err(format!("expected ',' or '}}', found {other:?}")),
            }
        }
    }

    fn parse_array(&mut self, depth: usize) -> Result<Value, String> {
        self.chars.next(); // '['
        let mut items = Vec::new();
        self.skip_ws();
        if matches!(self.chars.peek(), Some((_, ']'))) {
            self.chars.next();
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.parse_value(depth + 1)?);
            self.skip_ws();
            match self.next_char()? {
                ',' => continue,
                ']' => return Ok(Value::Array(items)),
                other => return Err(format!("expected ',' or ']', found {other:?}")),
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        if self.next_char()? != '"' {
            return Err("expected string".into());
        }
        let mut out = String::new();
        loop {
            let c = self.next_char()?;
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let esc = self.next_char()?;
                    match esc {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{08}'),
                        'f' => out.push('\u{0c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let unit = self.parse_hex4()?;
                            if (0xd800..=0xdbff).contains(&unit) {
                                // High surrogate: a low surrogate MUST follow.
                                if self.next_char()? != '\\' || self.next_char()? != 'u' {
                                    return Err("lone high surrogate".into());
                                }
                                let low = self.parse_hex4()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err("invalid low surrogate".into());
                                }
                                let cp = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
                                out.push(char::from_u32(cp).ok_or("invalid surrogate pair")?);
                            } else if (0xdc00..=0xdfff).contains(&unit) {
                                return Err("lone low surrogate".into());
                            } else {
                                out.push(char::from_u32(unit).ok_or("invalid \\u escape")?);
                            }
                        }
                        other => return Err(format!("invalid escape \\{other}")),
                    }
                }
                c if (c as u32) < 0x20 => {
                    return Err("unescaped control character in string".into());
                }
                c => out.push(c),
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let c = self.next_char()?;
            value = value * 16 + c.to_digit(16).ok_or("invalid hex digit in \\u escape")?;
        }
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<Value, String> {
        let start = self.chars.peek().map(|(i, _)| *i).unwrap_or(self.text.len());
        let mut end = start;
        let mut is_float = false;
        while let Some((i, c)) = self.chars.peek().copied() {
            match c {
                '0'..='9' | '-' | '+' => {}
                '.' | 'e' | 'E' => is_float = true,
                _ => break,
            }
            end = i + c.len_utf8();
            self.chars.next();
        }
        let raw = &self.text[start..end];
        // JSON grammar checks serde would also do, kept explicit: no leading
        // zeros, no bare '-', no '+' prefix.
        let body = raw.strip_prefix('-').unwrap_or(raw);
        if body.is_empty() || body.starts_with('+') {
            return Err("invalid number".into());
        }
        let int_part = body.split(['.', 'e', 'E']).next().unwrap_or("");
        if int_part.len() > 1 && int_part.starts_with('0') {
            return Err("invalid number: leading zero".into());
        }
        if is_float {
            let f: f64 = raw.parse().map_err(|_| "invalid number".to_string())?;
            if !f.is_finite() {
                return Err("invalid number".into());
            }
            return Ok(Value::Number(
                Number::from_f64(f).ok_or("invalid number")?,
            ));
        }
        if raw == "-0" {
            return Err("invalid number: -0".into());
        }
        let i: i64 = raw
            .parse()
            .map_err(|_| "invalid number: integer does not fit 64 bits".to_string())?;
        Ok(Value::Number(Number::from(i)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_ordinary_json() {
        let v = parse(r#"{"a": 1, "b": [true, null, "x😀y"], "c": {"d": -5}}"#.as_bytes()).unwrap();
        assert_eq!(v, json!({"a": 1, "b": [true, null, "x\u{1F600}y"], "c": {"d": -5}}));
    }

    #[test]
    fn rejects_duplicate_keys_at_every_level() {
        assert!(parse(br#"{"a":1,"a":2}"#).is_err());
        assert!(parse(br#"{"outer":{"a":1,"a":2}}"#).is_err());
        assert!(parse(br#"{"outer":[{"a":1,"a":2}]}"#).is_err());
        assert!(parse(br#"{"a":1,"b":2}"#).is_ok());
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(parse(b"{").is_err());
        assert!(parse(b"{}extra").is_err());
        assert!(parse(br#"{"a":01}"#).is_err());
        assert!(parse(br#"{"a":+1}"#).is_err());
        assert!(parse(br#"{"a":-0}"#).is_err());
        assert!(parse(br#"{"a":"\ud800"}"#).is_err(), "lone surrogate");
        assert!(parse(br#"{"a":"\zz"}"#).is_err(), "bad escape");
        assert!(parse(b"{\"a\":\"\x01\"}").is_err(), "raw control char");
        assert!(parse(&[0xff, 0xfe]).is_err(), "not UTF-8");
        assert!(parse(br#"{"a":18446744073709551615}"#).is_err(), "u64 overflow");
    }

    #[test]
    fn floats_parse_but_stay_floats() {
        let v = parse(br#"{"a":1.5,"b":1e3}"#).unwrap();
        assert!(v["a"].is_f64());
        assert!(v["b"].is_f64());
        let ints = parse(br#"{"a":7}"#).unwrap();
        assert!(ints["a"].is_i64());
    }

    #[test]
    fn depth_cap_enforced() {
        let mut deep = String::new();
        for _ in 0..70 {
            deep.push('[');
        }
        deep.push('1');
        for _ in 0..70 {
            deep.push(']');
        }
        assert!(parse(deep.as_bytes()).is_err());
    }
}
