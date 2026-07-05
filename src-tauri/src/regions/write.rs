//! DS9 region file writer — the inverse of `parse`.
//!
//! Output conventions (all readable by DS9 and astropy-regions, and by our
//! own parser — round-trip tests in `tests/region_fixtures.rs`):
//! - One shape per line; a frame line (`image` / `icrs`) whenever the frame
//!   changes. Sky regions are written as icrs (fk5 input is treated as icrs
//!   on parse, so the original keyword is not preserved).
//! - Positions: image = 1-based pixels, sky = decimal degrees. Sizes:
//!   image = pixels (bare), sky = arcsec (`"` suffix). Numbers use Rust's
//!   shortest exact f64 formatting, so values round-trip bit-identically.
//! - Properties only when set: color, width, dash, text, point.

use super::{Frame, Props, Region, Shape};

pub fn write_ds9(regions: &[Region]) -> String {
    let mut out = String::from("# Region file format: DS9 version 4.1\n");
    let mut frame: Option<Frame> = None;
    for region in regions {
        if frame != Some(region.frame) {
            out.push_str(match region.frame {
                Frame::Image => "image\n",
                Frame::Sky => "icrs\n",
            });
            frame = Some(region.frame);
        }
        write_region(&mut out, region);
        out.push('\n');
    }
    out
}

fn write_region(out: &mut String, region: &Region) {
    use std::fmt::Write;
    if !region.include {
        out.push('-');
    }
    // Size unit suffix: sky sizes are stored in arcsec.
    let u = match region.frame {
        Frame::Image => "",
        Frame::Sky => "\"",
    };
    match &region.shape {
        Shape::Circle { x, y, r } => {
            write!(out, "circle({x},{y},{r}{u})").unwrap();
        }
        Shape::Annulus { x, y, rin, rout } => {
            write!(out, "annulus({x},{y},{rin}{u},{rout}{u})").unwrap();
        }
        Shape::Ellipse { x, y, rx, ry, angle } => {
            write!(out, "ellipse({x},{y},{rx}{u},{ry}{u},{angle})").unwrap();
        }
        Shape::Box { x, y, w, h, angle } => {
            write!(out, "box({x},{y},{w}{u},{h}{u},{angle})").unwrap();
        }
        Shape::Polygon { pts } => {
            out.push_str("polygon(");
            for (i, (x, y)) in pts.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write!(out, "{x},{y}").unwrap();
            }
            out.push(')');
        }
        Shape::Point { x, y } => {
            write!(out, "point({x},{y})").unwrap();
        }
    }
    write_props(out, &region.props);
}

fn write_props(out: &mut String, props: &Props) {
    let Props { color, width, dash, text, point } = props;
    let mut sep = " #";
    let mut push = |s: String, out: &mut String| {
        out.push_str(sep);
        out.push(' ');
        out.push_str(&s);
        sep = "";
    };
    if let Some(c) = color {
        push(format!("color={c}"), out);
    }
    if let Some(w) = width {
        push(format!("width={w}"), out);
    }
    if *dash == Some(true) {
        push("dash=1".to_string(), out);
    }
    if let Some(p) = point {
        push(format!("point={p}"), out);
    }
    if let Some(t) = text {
        push(format!("text={{{t}}}"), out);
    }
}

#[cfg(test)]
mod tests {
    use super::super::parse::parse;
    use super::*;

    /// parse → write → parse must reproduce the regions exactly (the
    /// writer uses shortest-round-trip float formatting and the parser's
    /// own native units, so equality is bitwise).
    fn round_trips(text: &str) {
        let first = parse(text);
        assert!(first.warnings.is_empty(), "{:?}", first.warnings);
        let written = write_ds9(&first.regions);
        let second = parse(&written);
        assert!(second.warnings.is_empty(), "{written:?}: {:?}", second.warnings);
        assert_eq!(first.regions, second.regions, "written:\n{written}");
    }

    #[test]
    fn image_shapes_round_trip() {
        round_trips(
            "image\ncircle(32.5,24,10.5) # color=red width=2 text={core}\n\
             annulus(26,15,3,6.5)\nellipse(20,30,8,4,25) # dash=1\n\
             box(40,20,12.5,6,75)\npolygon(5,5,20,8,15,20)\n\
             -point(10,40) # point=cross\n",
        );
    }

    #[test]
    fn sky_shapes_round_trip() {
        round_trips(
            "icrs\ncircle(150.1163213,2.2058057,0.30\")\n\
             annulus(150.11635,2.20587,0.12\",0.25\") # color=magenta\n\
             ellipse(150.1162,2.20585,0.3\",0.15\",30)\n\
             -box(150.11645,-2.2059,0.6\",0.3\",45) # text={a b}\n",
        );
    }

    #[test]
    fn frame_switches_are_written() {
        let f = parse("icrs\ncircle(150.0,2.0,1\")\nimage\ncircle(5,5,2)\nicrs\npoint(150.0,2.0)\n");
        let written = write_ds9(&f.regions);
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(
            lines,
            vec![
                "# Region file format: DS9 version 4.1",
                "icrs",
                "circle(150,2,1\")",
                "image",
                "circle(5,5,2)",
                "icrs",
                "point(150,2)",
            ]
        );
    }
}
