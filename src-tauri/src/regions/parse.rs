//! DS9 region file parser.
//!
//! Grammar (informal): lines of statements separated by newlines or `;`
//! (top-level only — `;` inside `{…}`/quotes is literal). A statement is a
//! comment (`#…`), `global <props>`, a frame keyword (`image`, `fk5`, …),
//! or a shape: `[-|+]name(arg, …) # <props>`. Bad statements produce
//! warnings, never hard failures — DS9 files in the wild are messy.

use super::{Frame, Props, Region, RegionFile, Shape};
use crate::wcs::coords;

/// Frames we can't resolve to pixels (yet): remembered so their shapes are
/// skipped with a meaningful warning instead of being misinterpreted.
enum FrameState {
    Ok(Frame),
    Unsupported(String),
}

pub fn parse(text: &str) -> RegionFile {
    let mut out = RegionFile::default();
    // DS9's default system when a file names none is physical ≡ image here.
    let mut frame = FrameState::Ok(Frame::Image);
    let mut global = Props::default();

    for (lineno, line) in text.lines().enumerate() {
        for stmt in split_statements(line) {
            let stmt = stmt.trim();
            if stmt.is_empty() || stmt.starts_with('#') {
                continue;
            }
            let lower = stmt.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("global") {
                if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                    global = parse_props(&stmt["global".len()..]).merged_over(&global);
                    continue;
                }
            }
            if let Some(next) = frame_keyword(&lower) {
                frame = next;
                if let FrameState::Unsupported(name) = &frame {
                    out.warnings.push(format!(
                        "line {}: coordinate system \"{name}\" is not supported — its regions are skipped",
                        lineno + 1
                    ));
                }
                continue;
            }
            match &frame {
                FrameState::Unsupported(_) => {} // already warned at the frame line
                FrameState::Ok(f) => match parse_shape(stmt, *f, &global) {
                    Ok(regions) => out.regions.extend(regions),
                    Err(msg) => out.warnings.push(format!("line {}: {msg}", lineno + 1)),
                },
            }
        }
    }
    out
}

/// Split a line on top-level `;` — semicolons inside `(…)`, `{…}`, or (in
/// the `# props` section) quoted strings stay literal. Quote characters are
/// only string delimiters after `#`; in the argument list they are DS9 size
/// units (0.30" = arcsec, 0.005' = arcmin).
fn split_statements(line: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let (mut paren, mut brace) = (0i32, 0i32);
    let mut in_props = false;
    let mut quote: Option<char> = None;
    for (i, c) in line.char_indices() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '#' if paren == 0 && brace == 0 => in_props = true,
            '"' | '\'' if in_props => quote = Some(c),
            '(' => paren += 1,
            ')' => paren = (paren - 1).max(0),
            '{' => brace += 1,
            '}' => brace = (brace - 1).max(0),
            ';' if paren == 0 && brace == 0 => {
                parts.push(&line[start..i]);
                start = i + 1;
                in_props = false;
            }
            _ => {}
        }
    }
    parts.push(&line[start..]);
    parts
}

fn frame_keyword(lower: &str) -> Option<FrameState> {
    match lower {
        "image" | "physical" | "amplifier" | "detector" => Some(FrameState::Ok(Frame::Image)),
        // fk5 ≈ icrs (23 mas apart; see module docs).
        "fk5" | "icrs" | "j2000" => Some(FrameState::Ok(Frame::Sky)),
        "galactic" | "ecliptic" | "fk4" | "b1950" | "linear" | "wcs" => {
            Some(FrameState::Unsupported(lower.to_string()))
        }
        _ if lower.len() == 4 && lower.starts_with("wcs") => {
            Some(FrameState::Unsupported(lower.to_string()))
        }
        _ => None,
    }
}

/// Parse one shape statement. Usually one region; a multi-radius annulus
/// expands to several (like astropy-regions).
fn parse_shape(stmt: &str, frame: Frame, global: &Props) -> Result<Vec<Region>, String> {
    let (include, rest) = match stmt.strip_prefix('-') {
        Some(r) => (false, r),
        None => (true, stmt.strip_prefix('+').unwrap_or(stmt)),
    };
    let rest = rest.trim_start();

    // Shape name = leading alphabetic run.
    let name_end = rest.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(rest.len());
    let name = rest[..name_end].to_ascii_lowercase();
    if name.is_empty() {
        return Err(format!("cannot parse \"{}\"", stmt.trim()));
    }
    let after_name = &rest[name_end..];

    // Arguments: inside (...) if present, else up to `#`. Properties after #.
    let (args_str, props_str) = match after_name.split_once('#') {
        Some((a, p)) => (a, Some(p)),
        None => (after_name, None),
    };
    let args: Vec<&str> = args_str
        .split(|c: char| c == '(' || c == ')' || c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .collect();

    let props = match props_str {
        Some(p) => parse_props(p).merged_over(global),
        None => global.clone(),
    };

    match name.as_str() {
        "circle" | "ellipse" | "box" | "polygon" | "point" | "annulus" => {
            build_shapes(&name, &args, frame, include, props)
        }
        // Recognized DS9 shapes we don't support yet.
        "panda" | "epanda" | "bpanda" | "line" | "vector" | "text"
        | "ruler" | "compass" | "projection" | "segment" | "composite" => {
            Err(format!("shape \"{name}\" is not supported yet — skipped"))
        }
        other => Err(format!("unknown shape \"{other}\" — skipped")),
    }
}

fn build_shapes(
    name: &str,
    args: &[&str],
    frame: Frame,
    include: bool,
    props: Props,
) -> Result<Vec<Region>, String> {
    let pos = |i: usize| -> Result<(f64, f64), String> {
        parse_position(args.get(i).copied(), args.get(i + 1).copied(), frame)
    };
    let size = |i: usize| -> Result<f64, String> {
        parse_size(
            args.get(i)
                .ok_or_else(|| format!("{name}: missing size argument"))?,
            frame,
        )
    };
    let angle = |i: usize| -> Result<f64, String> {
        match args.get(i) {
            None => Ok(0.0),
            Some(tok) => tok
                .parse::<f64>()
                .map_err(|_| format!("{name}: bad angle \"{tok}\"")),
        }
    };

    let shape = match name {
        "circle" => {
            expect_args(name, args.len(), &[3])?;
            let (x, y) = pos(0)?;
            Shape::Circle { x, y, r: size(2)? }
        }
        "annulus" => {
            // annulus(x, y, r1, r2[, r3, …]) — N radii = N−1 concentric
            // annuli on consecutive radius pairs (astropy-regions semantics).
            if args.len() < 4 {
                return Err(format!("annulus: expected ≥4 arguments, got {}", args.len()));
            }
            let (x, y) = pos(0)?;
            let radii: Vec<f64> = (2..args.len()).map(size).collect::<Result<_, _>>()?;
            if radii.windows(2).any(|w| w[1] <= w[0]) {
                return Err("annulus: radii must be strictly increasing".into());
            }
            return Ok(radii
                .windows(2)
                .map(|w| Region {
                    frame,
                    shape: Shape::Annulus { x, y, rin: w[0], rout: w[1] },
                    include,
                    props: props.clone(),
                })
                .collect());
        }
        "ellipse" => {
            expect_args(name, args.len(), &[4, 5])?;
            let (x, y) = pos(0)?;
            Shape::Ellipse { x, y, rx: size(2)?, ry: size(3)?, angle: angle(4)? }
        }
        "box" => {
            expect_args(name, args.len(), &[4, 5])?;
            let (x, y) = pos(0)?;
            Shape::Box { x, y, w: size(2)?, h: size(3)?, angle: angle(4)? }
        }
        "polygon" => {
            if args.len() < 6 || args.len() % 2 != 0 {
                return Err(format!(
                    "polygon: expected an even number (≥6) of coordinates, got {}",
                    args.len()
                ));
            }
            let mut pts = Vec::with_capacity(args.len() / 2);
            for i in (0..args.len()).step_by(2) {
                pts.push(pos(i)?);
            }
            Shape::Polygon { pts }
        }
        "point" => {
            expect_args(name, args.len(), &[2])?;
            let (x, y) = pos(0)?;
            Shape::Point { x, y }
        }
        _ => unreachable!("caller filters shape names"),
    };
    Ok(vec![Region { frame, shape, include, props }])
}

fn expect_args(name: &str, got: usize, want: &[usize]) -> Result<(), String> {
    if want.contains(&got) {
        Ok(())
    } else {
        Err(format!("{name}: expected {want:?} arguments, got {got}"))
    }
}

/// A coordinate pair. Sky frame: DS9 conventions via wcs::coords
/// (sexagesimal RA is hours, bare numbers are degrees). Image frame:
/// pixels; a trailing i/p unit suffix is tolerated.
fn parse_position(
    a: Option<&str>,
    b: Option<&str>,
    frame: Frame,
) -> Result<(f64, f64), String> {
    let (a, b) = match (a, b) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err("missing coordinate".into()),
    };
    match frame {
        Frame::Sky => {
            let ra = coords::parse_token(a, true)
                .ok_or_else(|| format!("cannot parse sky coordinate \"{a}\""))?;
            let dec = coords::parse_token(b, false)
                .ok_or_else(|| format!("cannot parse sky coordinate \"{b}\""))?;
            Ok((ra, dec))
        }
        Frame::Image => Ok((parse_pixel(a)?, parse_pixel(b)?)),
    }
}

fn parse_pixel(tok: &str) -> Result<f64, String> {
    let t = tok.trim_end_matches(['i', 'p']);
    t.parse::<f64>()
        .map_err(|_| format!("cannot parse pixel coordinate \"{tok}\""))
}

/// Radius / side length. Sky frame → arcsec: `"`=arcsec, `'`=arcmin,
/// d=degrees, r=radians, bare=degrees (DS9 default). Image frame → pixels.
fn parse_size(tok: &str, frame: Frame) -> Result<f64, String> {
    let (num, unit) = match tok.char_indices().last() {
        Some((i, c)) if !c.is_ascii_digit() && c != '.' => (&tok[..i], Some(c)),
        _ => (tok, None),
    };
    let v: f64 = num
        .parse()
        .map_err(|_| format!("cannot parse size \"{tok}\""))?;
    match frame {
        Frame::Sky => match unit {
            Some('"') => Ok(v),
            Some('\'') => Ok(v * 60.0),
            Some('d') | None => Ok(v * 3600.0),
            Some('r') => Ok(v.to_degrees() * 3600.0),
            Some('i') | Some('p') => {
                Err(format!("pixel-unit size \"{tok}\" in a sky frame is not supported"))
            }
            Some(u) => Err(format!("unknown size unit '{u}' in \"{tok}\"")),
        },
        Frame::Image => match unit {
            None | Some('i') | Some('p') => Ok(v),
            Some(u) => Err(format!(
                "angular size unit '{u}' in an image-frame region is not supported"
            )),
        },
    }
}

/// Properties after `#`: `key=value` pairs where value is `{…}`, quoted, or
/// a bare token. `point=<name> [size]` and `dashlist=N M` swallow their
/// extra tokens. Unknown keys are ignored (DS9 has many cosmetic ones).
fn parse_props(s: &str) -> Props {
    let mut props = Props::default();
    let mut rest = s.trim();
    while let Some(eq) = rest.find('=') {
        let key = rest[..eq].trim().rsplit(char::is_whitespace).next().unwrap_or("").to_ascii_lowercase();
        let after = rest[eq + 1..].trim_start();
        let (value, consumed) = take_value(after);
        rest = &after[consumed..];
        match key.as_str() {
            "color" => props.color = Some(value.to_ascii_lowercase()),
            "width" => props.width = value.parse().ok(),
            "dash" => props.dash = Some(value.trim() == "1"),
            "text" => props.text = Some(value),
            "point" => {
                props.point = Some(value.to_ascii_lowercase());
                // Optional marker size after the name: "point=circle 11".
                let t = rest.trim_start();
                if let Some(tok) = t.split_whitespace().next() {
                    if tok.parse::<f64>().is_ok() {
                        rest = &t[tok.len()..];
                    }
                }
            }
            "dashlist" => {
                // Two bare numbers ("8 3"); the first came as `value`.
                let t = rest.trim_start();
                if let Some(tok) = t.split_whitespace().next() {
                    if tok.parse::<f64>().is_ok() {
                        rest = &t[tok.len()..];
                    }
                }
            }
            _ => {} // font, select, edit, move, tag, … — display-irrelevant here
        }
    }
    props
}

/// Take one property value from the start of `s`: `{…}` (braces stripped),
/// a quoted string, or a bare whitespace-delimited token. Returns the value
/// and the byte length consumed from `s`.
fn take_value(s: &str) -> (String, usize) {
    let mut chars = s.char_indices();
    match chars.next() {
        Some((_, '{')) => match s.find('}') {
            Some(end) => (s[1..end].to_string(), end + 1),
            None => (s[1..].to_string(), s.len()),
        },
        Some((_, q @ ('"' | '\''))) => match s[1..].find(q) {
            Some(end) => (s[1..1 + end].to_string(), end + 2),
            None => (s[1..].to_string(), s.len()),
        },
        _ => {
            let end = s.find(char::is_whitespace).unwrap_or(s.len());
            (s[..end].to_string(), end)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape_of(file: &RegionFile, i: usize) -> &Shape {
        &file.regions[i].shape
    }

    #[test]
    fn parses_minimal_image_file() {
        let f = parse("image\ncircle(10,20,5)\n");
        assert!(f.warnings.is_empty(), "{:?}", f.warnings);
        assert_eq!(f.regions.len(), 1);
        assert_eq!(shape_of(&f, 0), &Shape::Circle { x: 10.0, y: 20.0, r: 5.0 });
    }

    #[test]
    fn default_frame_is_image() {
        let f = parse("circle(10,20,5)\n");
        assert_eq!(f.regions[0].frame, Frame::Image);
    }

    #[test]
    fn space_separated_no_paren_form() {
        let f = parse("image\ncircle 10 20 5\n");
        assert_eq!(shape_of(&f, 0), &Shape::Circle { x: 10.0, y: 20.0, r: 5.0 });
    }

    #[test]
    fn four_arg_box_gets_zero_angle() {
        let f = parse("image\nbox(10,20,4,2)\n");
        assert_eq!(
            shape_of(&f, 0),
            &Shape::Box { x: 10.0, y: 20.0, w: 4.0, h: 2.0, angle: 0.0 }
        );
    }

    #[test]
    fn sky_units_and_sexagesimal() {
        let f = parse("fk5\ncircle(10:00:27.9,+02:12:20.5,0.5')\n");
        assert!(f.warnings.is_empty(), "{:?}", f.warnings);
        match shape_of(&f, 0) {
            Shape::Circle { x, y, r } => {
                assert!((x - 150.11625).abs() < 1e-4, "ra {x}");
                assert!((y - 2.205694).abs() < 1e-4, "dec {y}");
                assert!((r - 30.0).abs() < 1e-9, "r {r}");
            }
            other => panic!("wrong shape {other:?}"),
        }
    }

    #[test]
    fn bare_sky_size_is_degrees() {
        let f = parse("icrs\ncircle(150.0,2.0,0.001)\n");
        match shape_of(&f, 0) {
            Shape::Circle { r, .. } => assert!((r - 3.6).abs() < 1e-9),
            other => panic!("wrong shape {other:?}"),
        }
    }

    #[test]
    fn exclude_and_props() {
        let f = parse(
            "global color=green width=1\nimage\n-circle(5,5,2) # color=red text={a b} dash=1\n",
        );
        let r = &f.regions[0];
        assert!(!r.include);
        assert_eq!(r.props.color.as_deref(), Some("red"));
        assert_eq!(r.props.width, Some(1.0)); // from global
        assert_eq!(r.props.text.as_deref(), Some("a b"));
        assert_eq!(r.props.dash, Some(true));
    }

    #[test]
    fn point_marker_with_size() {
        let f = parse("image\npoint(3,4) # point=circle 11 color=blue\n");
        let r = &f.regions[0];
        assert_eq!(r.props.point.as_deref(), Some("circle"));
        assert_eq!(r.props.color.as_deref(), Some("blue"));
    }

    #[test]
    fn semicolons_split_but_not_inside_braces() {
        let f = parse("image\ncircle(1,2,3); box(4,5,2,2,0) # text={a;b}\n");
        assert_eq!(f.regions.len(), 2);
        assert_eq!(f.regions[1].props.text.as_deref(), Some("a;b"));
    }

    #[test]
    fn inline_frame_prefix() {
        let f = parse("fk5; circle(150.0,2.0,1\")\n");
        assert_eq!(f.regions[0].frame, Frame::Sky);
    }

    #[test]
    fn unsupported_frame_and_shape_warn_and_skip() {
        let f = parse("galactic\ncircle(120,45,0.1)\nimage\npanda(5,5,0,360,4,2,4,1)\nbogus(1,2)\n");
        assert!(f.regions.is_empty());
        assert_eq!(f.warnings.len(), 3, "{:?}", f.warnings);
        assert!(f.warnings[0].contains("galactic"));
        assert!(f.warnings[1].contains("panda"));
        assert!(f.warnings[2].contains("bogus"));
    }

    #[test]
    fn annulus_two_radii() {
        let f = parse("image\nannulus(32,24,4,8)\n");
        assert!(f.warnings.is_empty(), "{:?}", f.warnings);
        assert_eq!(
            shape_of(&f, 0),
            &Shape::Annulus { x: 32.0, y: 24.0, rin: 4.0, rout: 8.0 }
        );
    }

    #[test]
    fn annulus_multi_radius_expands_to_pairs() {
        let f = parse("image\nannulus(32,24,3,5,7,9) # color=red\n");
        assert_eq!(f.regions.len(), 3);
        assert_eq!(
            shape_of(&f, 1),
            &Shape::Annulus { x: 32.0, y: 24.0, rin: 5.0, rout: 7.0 }
        );
        assert!(f.regions.iter().all(|r| r.props.color.as_deref() == Some("red")));
    }

    #[test]
    fn annulus_nonincreasing_radii_rejected() {
        let f = parse("image\nannulus(32,24,8,4)\n");
        assert!(f.regions.is_empty());
        assert_eq!(f.warnings.len(), 1);
        assert!(f.warnings[0].contains("increasing"));
    }

    #[test]
    fn comments_and_blank_lines_ignored() {
        let f = parse("# Region file format: DS9\n\nimage\n# just a comment\ncircle(1,1,1)\n");
        assert_eq!(f.regions.len(), 1);
        assert!(f.warnings.is_empty());
    }

    #[test]
    fn polygon_odd_coords_rejected() {
        let f = parse("image\npolygon(1,2,3,4,5)\n");
        assert!(f.regions.is_empty());
        assert_eq!(f.warnings.len(), 1);
    }
}
