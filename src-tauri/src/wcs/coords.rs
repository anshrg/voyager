//! Sexagesimal formatting and coordinate-string parsing (DS9 conventions:
//! RA in hours when sexagesimal, degrees when a bare number; Dec always
//! degrees).

/// Decompose a positive value into (units, minutes, seconds) with the
/// seconds rounded to `decimals` places and carries propagated, so
/// 59.9996″ becomes the next minute instead of printing 60.000.
fn sexagesimal(value: f64, decimals: u32) -> (u64, u64, f64) {
    let scale = 10f64.powi(decimals as i32);
    let total = (value * 3600.0 * scale).round() as u64; // ticks of 1/scale arcsec
    let ticks_per_sec = scale as u64;
    let sec_ticks = total % (60 * ticks_per_sec);
    let total_min = total / (60 * ticks_per_sec);
    (
        total_min / 60,
        total_min % 60,
        sec_ticks as f64 / scale,
    )
}

/// RA degrees → "hh:mm:ss.sss" (0.001 s ≈ 15 mas).
pub fn fmt_ra_hms(ra_deg: f64) -> String {
    let hours = (ra_deg.rem_euclid(360.0)) / 15.0;
    let (h, m, s) = sexagesimal(hours, 3);
    format!("{:02}:{:02}:{:06.3}", h % 24, m, s)
}

/// Dec degrees → "+dd:mm:ss.ss".
pub fn fmt_dec_dms(dec_deg: f64) -> String {
    let sign = if dec_deg < 0.0 { '-' } else { '+' };
    let (d, m, s) = sexagesimal(dec_deg.abs(), 2);
    format!("{}{:02}:{:02}:{:05.2}", sign, d, m, s)
}

/// One token → degrees. `is_ra` controls the sexagesimal unit (hours for
/// RA unless the token says degrees with a 'd'). Accepted forms:
/// "150.1163", "10:00:27.9", "10h00m27.9s", "+02:12:20", "-2d12m20s".
/// Also used by the DS9 region parser (same DS9 conventions).
pub(crate) fn parse_token(token: &str, is_ra: bool) -> Option<f64> {
    let t = token.trim();
    if t.is_empty() {
        return None;
    }
    // Plain decimal degrees.
    if let Ok(v) = t.parse::<f64>() {
        return Some(v);
    }

    let (sign, rest) = match t.strip_prefix('-') {
        Some(r) => (-1.0, r),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    let lower = rest.to_ascii_lowercase();
    let in_hours = is_ra && !lower.contains('d');

    // Split numeric fields on any separator characters.
    let fields: Vec<f64> = lower
        .split(|c: char| ":hdms°′″'\"".contains(c) || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<f64>())
        .collect::<Result<_, _>>()
        .ok()?;
    if fields.is_empty() || fields.len() > 3 {
        return None;
    }
    let value = fields[0]
        + fields.get(1).copied().unwrap_or(0.0) / 60.0
        + fields.get(2).copied().unwrap_or(0.0) / 3600.0;
    Some(sign * value * if in_hours { 15.0 } else { 1.0 })
}

/// Parse a two-coordinate query into (ra, dec) degrees, or a description of
/// what went wrong. Accepts "150.1 2.2", "150.1, 2.2",
/// "10:00:27.9 +02:12:20", "10h00m27.92s 2d12m20.4s".
pub fn parse_coord(query: &str) -> Result<(f64, f64), String> {
    let cleaned = query.trim().replace(',', " ");
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    // Sexagesimal with internal spaces ("10 00 27.9 +02 12 20") → 6 tokens.
    let (ra_str, dec_str) = match tokens.len() {
        2 => (tokens[0].to_string(), tokens[1].to_string()),
        6 => (tokens[..3].join(":"), tokens[3..].join(":")),
        n => {
            return Err(format!(
                "expected two coordinates (got {n} token{}) — e.g. \"150.116 2.206\" or \"10:00:27.9 +02:12:20\"",
                if n == 1 { "" } else { "s" }
            ))
        }
    };
    let ra = parse_token(&ra_str, true).ok_or_else(|| format!("cannot parse RA \"{ra_str}\""))?;
    let dec =
        parse_token(&dec_str, false).ok_or_else(|| format!("cannot parse Dec \"{dec_str}\""))?;
    if !(-90.0..=90.0).contains(&dec) {
        return Err(format!("Dec {dec} out of range [-90, 90]"));
    }
    Ok((ra.rem_euclid(360.0), dec))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    #[test]
    fn formats_ra_dec() {
        assert_eq!(fmt_ra_hms(150.1163213), "10:00:27.917");
        assert_eq!(fmt_dec_dms(2.2058057), "+02:12:20.90");
        assert_eq!(fmt_dec_dms(-0.5), "-00:30:00.00");
        assert_eq!(fmt_ra_hms(0.0), "00:00:00.000");
    }

    #[test]
    fn seconds_rounding_carries() {
        // 23:59:59.9999h rounds to 0.000 of the next day → wraps to 00h.
        assert_eq!(fmt_ra_hms(359.9999999), "00:00:00.000");
        assert_eq!(fmt_dec_dms(29.999999999), "+30:00:00.00");
    }

    #[test]
    fn parses_decimal_degrees() {
        let (ra, dec) = parse_coord("150.1163213, 2.2058057").unwrap();
        assert!(close(ra, 150.1163213, 1e-9) && close(dec, 2.2058057, 1e-9));
    }

    #[test]
    fn parses_colon_sexagesimal_ra_in_hours() {
        let (ra, dec) = parse_coord("10:00:27.917 +02:12:20.90").unwrap();
        assert!(close(ra, 150.1163213, 1e-4), "ra {ra}");
        assert!(close(dec, 2.2058057, 1e-5), "dec {dec}");
    }

    #[test]
    fn parses_hms_dms_units() {
        let (ra, dec) = parse_coord("10h00m27.917s -2d12m20.9s").unwrap();
        assert!(close(ra, 150.1163213, 1e-4));
        assert!(close(dec, -2.2058057, 1e-5));
    }

    #[test]
    fn parses_six_token_form() {
        let (ra, dec) = parse_coord("10 00 27.917 +02 12 20.90").unwrap();
        assert!(close(ra, 150.1163213, 1e-4) && close(dec, 2.2058057, 1e-5));
    }

    #[test]
    fn explicit_degree_ra() {
        // 'd' marks the RA token as degrees, not hours.
        let (ra, _) = parse_coord("150d06m58.76s +2:12:20").unwrap();
        assert!(close(ra, 150.11632, 1e-4), "ra {ra}");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_coord("hello world").is_err());
        assert!(parse_coord("150.1").is_err());
        assert!(parse_coord("10:00:00 +95:00:00").is_err());
    }
}
