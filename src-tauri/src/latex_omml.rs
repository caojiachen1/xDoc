//! Minimal LaTeX math -> OMML (Office Math Markup Language) converter.
//!
//! Converts the subset of LaTeX math produced by end-to-end OCR models into
//! editable Word equations. Supports super/subscripts, fractions, radicals,
//! n-ary operators (sum/prod/int), delimiters, Greek letters and common
//! symbols, named functions, and upright text (`\text{}`, `\mathrm{}`).
//!
//! The output is an `<m:oMath>...</m:oMath>` fragment (without namespace
//! declarations) intended to be embedded inside a WordprocessingML document
//! where the `m:` prefix is bound to the OMML namespace.

/// Convert a LaTeX math string into an `<m:oMath>` OMML fragment.
pub fn latex_to_omml(latex: &str) -> String {
    let tokens = tokenize(latex);
    let mut parser = Parser { tokens, pos: 0 };
    let node = parser.parse_row(false);
    let mut out = String::from("<m:oMath>");
    serialize(&node, &mut out);
    out.push_str("</m:oMath>");
    out
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Cmd(String),  // a command like \frac, \alpha (without backslash)
    LBrace,
    RBrace,
    Sup,          // ^
    Sub,          // _
    Amp,          // & (table/matrix separator, treated as space here)
    Char(char),
}

fn tokenize(src: &str) -> Vec<Tok> {
    let chars: Vec<char> = src.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                i += 1;
                if i >= chars.len() {
                    break;
                }
                let first = chars[i];
                if first.is_alphabetic() {
                    let mut name = String::new();
                    while i < chars.len() && chars[i].is_alphabetic() {
                        name.push(chars[i]);
                        i += 1;
                    }
                    toks.push(Tok::Cmd(name));
                } else {
                    // Escaped single char command: \{, \}, \,, \\, \%, etc.
                    toks.push(Tok::Cmd(first.to_string()));
                    i += 1;
                }
            }
            '{' => {
                toks.push(Tok::LBrace);
                i += 1;
            }
            '}' => {
                toks.push(Tok::RBrace);
                i += 1;
            }
            '^' => {
                toks.push(Tok::Sup);
                i += 1;
            }
            '_' => {
                toks.push(Tok::Sub);
                i += 1;
            }
            '&' => {
                toks.push(Tok::Amp);
                i += 1;
            }
            ' ' | '\t' | '\n' | '\r' => {
                i += 1; // whitespace is not significant in math
            }
            _ => {
                toks.push(Tok::Char(c));
                i += 1;
            }
        }
    }
    toks
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Node {
    Row(Vec<Node>),
    /// Italic identifier / variable (default math run).
    Ident(String),
    /// Upright text (operators, function names, \text, numbers).
    Upright(String),
    Sup(Box<Node>, Box<Node>),
    Sub(Box<Node>, Box<Node>),
    SubSup(Box<Node>, Box<Node>, Box<Node>),
    Frac(Box<Node>, Box<Node>),
    /// Square root or nth root (degree optional).
    Rad(Option<Box<Node>>, Box<Node>),
    /// N-ary operator: symbol, subscript (lower), superscript (upper), body.
    Nary(String, Option<Box<Node>>, Option<Box<Node>>, Box<Node>),
    /// Delimited group: open char, body, close char.
    Delim(String, Box<Node>, String),
    /// Accent (e.g. \hat, \bar, \vec) over base.
    Accent(String, Box<Node>),
    Empty,
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

struct Parser {
    tokens: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Tok> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    /// Parse a sequence of atoms until end or a closing brace (consumed by
    /// caller when `stop_on_brace` is true).
    fn parse_row(&mut self, stop_on_brace: bool) -> Node {
        let mut items: Vec<Node> = Vec::new();
        while let Some(tok) = self.peek() {
            match tok {
                Tok::RBrace => {
                    if stop_on_brace {
                        break;
                    }
                    // Stray closing brace: skip.
                    self.next();
                }
                _ => {
                    let atom = self.parse_atom();
                    let atom = self.attach_scripts(atom);
                    items.push(atom);
                }
            }
        }
        coalesce(items)
    }

    /// Parse a single group `{...}` or one atom, without scripts.
    fn parse_group(&mut self) -> Node {
        match self.peek() {
            Some(Tok::LBrace) => {
                self.next();
                let inner = self.parse_row(true);
                // consume closing brace if present
                if matches!(self.peek(), Some(Tok::RBrace)) {
                    self.next();
                }
                inner
            }
            _ => {
                let atom = self.parse_atom();
                self.attach_scripts(atom)
            }
        }
    }

    fn parse_atom(&mut self) -> Node {
        match self.next() {
            Some(Tok::LBrace) => {
                let inner = self.parse_row(true);
                if matches!(self.peek(), Some(Tok::RBrace)) {
                    self.next();
                }
                inner
            }
            Some(Tok::Char(c)) => classify_char(c),
            Some(Tok::Cmd(name)) => self.parse_command(&name),
            Some(Tok::Amp) => Node::Upright(" ".to_string()),
            Some(Tok::Sup) | Some(Tok::Sub) => {
                // A script with no base; treat base as empty.
                self.pos -= 1;
                Node::Empty
            }
            Some(Tok::RBrace) | None => Node::Empty,
        }
    }

    /// After an atom, attach any `^` / `_` scripts (in either order).
    fn attach_scripts(&mut self, base: Node) -> Node {
        let mut sup: Option<Node> = None;
        let mut sub: Option<Node> = None;
        loop {
            match self.peek() {
                Some(Tok::Sup) if sup.is_none() => {
                    self.next();
                    sup = Some(self.parse_group());
                }
                Some(Tok::Sub) if sub.is_none() => {
                    self.next();
                    sub = Some(self.parse_group());
                }
                _ => break,
            }
        }
        match (sub, sup) {
            (None, None) => base,
            (Some(sb), None) => Node::Sub(Box::new(base), Box::new(sb)),
            (None, Some(sp)) => Node::Sup(Box::new(base), Box::new(sp)),
            (Some(sb), Some(sp)) => {
                Node::SubSup(Box::new(base), Box::new(sb), Box::new(sp))
            }
        }
    }

    fn parse_command(&mut self, name: &str) -> Node {
        match name {
            "frac" | "dfrac" | "tfrac" | "cfrac" => {
                let num = self.parse_group();
                let den = self.parse_group();
                Node::Frac(Box::new(num), Box::new(den))
            }
            "sqrt" => {
                // Optional degree in [ ].
                let degree = self.parse_optional_bracket();
                let body = self.parse_group();
                Node::Rad(degree.map(Box::new), Box::new(body))
            }
            "text" | "mathrm" | "mathbf" | "mathit" | "operatorname" | "mathsf"
            | "mathtt" | "mathcal" | "mathbb" | "mathfrak" | "boldsymbol" => {
                let inner = self.parse_group();
                Node::Upright(flatten_text(&inner))
            }
            "left" => self.parse_left_right(),
            "sum" | "prod" | "coprod" | "int" | "iint" | "iiint" | "oint"
            | "bigcup" | "bigcap" | "bigoplus" | "bigotimes" | "bigvee"
            | "bigwedge" | "bigsqcup" | "biguplus" | "bigodot" => {
                self.parse_nary(nary_symbol(name))
            }
            "hat" | "widehat" | "bar" | "overline" | "vec" | "tilde"
            | "widetilde" | "dot" | "ddot" | "check" | "acute" | "grave"
            | "breve" => {
                let base = self.parse_group();
                Node::Accent(accent_char(name).to_string(), Box::new(base))
            }
            "begin" => self.parse_environment(),
            "end" => {
                // consume the env name group and ignore
                let _ = self.parse_group();
                Node::Empty
            }
            "quad" | "qquad" | "," | ";" | ":" | "!" | " " | "thinspace"
            | "medspace" | "thickspace" | "enspace" => {
                Node::Upright(" ".to_string())
            }
            "\\" => Node::Empty, // line break inside math -> ignore
            "{" => Node::Upright("{".to_string()),
            "}" => Node::Upright("}".to_string()),
            "%" => Node::Upright("%".to_string()),
            "&" => Node::Upright("&".to_string()),
            "#" => Node::Upright("#".to_string()),
            "$" => Node::Upright("$".to_string()),
            "_" => Node::Upright("_".to_string()),
            "limits" | "nolimits" | "displaystyle" | "textstyle"
            | "scriptstyle" | "scriptscriptstyle" | "nonumber" => Node::Empty,
            _ => {
                // Function names (\sin, \cos, \log, ...) -> upright.
                if is_function_name(name) {
                    Node::Upright(name.to_string())
                } else if let Some(sym) = symbol_for(name) {
                    // Greek letters and symbols keep italic/normal per Word.
                    Node::Ident(sym.to_string())
                } else {
                    // Unknown command: render its name as upright text.
                    Node::Upright(name.to_string())
                }
            }
        }
    }

    /// Parse an optional `[...]` bracket group (used by \sqrt).
    fn parse_optional_bracket(&mut self) -> Option<Node> {
        if let Some(Tok::Char('[')) = self.peek() {
            self.next(); // consume '['
            let mut items = Vec::new();
            while let Some(tok) = self.peek() {
                if matches!(tok, Tok::Char(']')) {
                    self.next();
                    break;
                }
                let atom = self.parse_atom();
                let atom = self.attach_scripts(atom);
                items.push(atom);
            }
            Some(coalesce(items))
        } else {
            None
        }
    }

    /// Parse `\left<delim> ... \right<delim>`.
    fn parse_left_right(&mut self) -> Node {
        let open = self.read_delim_char();
        let mut items: Vec<Node> = Vec::new();
        while let Some(tok) = self.peek() {
            if let Tok::Cmd(name) = tok {
                if name == "right" {
                    self.next(); // consume \right
                    let close = self.read_delim_char();
                    return Node::Delim(open, Box::new(coalesce(items)), close);
                }
            }
            let atom = self.parse_atom();
            let atom = self.attach_scripts(atom);
            items.push(atom);
        }
        // No matching \right: emit as delimiter with empty close.
        Node::Delim(open, Box::new(coalesce(items)), String::new())
    }

    /// Read the delimiter character following \left or \right.
    fn read_delim_char(&mut self) -> String {
        match self.next() {
            Some(Tok::Char('.')) => String::new(), // \left. -> no delimiter
            Some(Tok::Char(c)) => c.to_string(),
            Some(Tok::Cmd(name)) => delim_symbol(&name),
            _ => String::new(),
        }
    }

    /// Parse an n-ary operator, collecting sub/sup limits and a body.
    fn parse_nary(&mut self, symbol: &str) -> Node {
        let mut sub: Option<Node> = None;
        let mut sup: Option<Node> = None;
        loop {
            match self.peek() {
                Some(Tok::Sub) if sub.is_none() => {
                    self.next();
                    sub = Some(self.parse_group());
                }
                Some(Tok::Sup) if sup.is_none() => {
                    self.next();
                    sup = Some(self.parse_group());
                }
                _ => break,
            }
        }
        // The body is the next single atom/group (best-effort).
        let body = match self.peek() {
            Some(Tok::LBrace) => self.parse_group(),
            Some(_) => {
                let atom = self.parse_atom();
                self.attach_scripts(atom)
            }
            None => Node::Empty,
        };
        Node::Nary(
            symbol.to_string(),
            sub.map(Box::new),
            sup.map(Box::new),
            Box::new(body),
        )
    }

    /// Parse a `\begin{env}...\end{env}` block as a row (matrices flattened).
    fn parse_environment(&mut self) -> Node {
        let _env = self.parse_group(); // env name, ignored
        let mut items: Vec<Node> = Vec::new();
        while let Some(tok) = self.peek() {
            if let Tok::Cmd(name) = tok {
                if name == "end" {
                    self.next();
                    let _ = self.parse_group();
                    break;
                }
            }
            let atom = self.parse_atom();
            let atom = self.attach_scripts(atom);
            items.push(atom);
        }
        coalesce(items)
    }
}

/// Merge adjacent Upright/Ident text nodes for cleaner output.
fn coalesce(items: Vec<Node>) -> Node {
    let mut merged: Vec<Node> = Vec::new();
    for node in items {
        if let Node::Empty = node {
            continue;
        }
        match (merged.last_mut(), &node) {
            (Some(Node::Upright(prev)), Node::Upright(cur)) => {
                prev.push_str(cur);
            }
            _ => merged.push(node),
        }
    }
    match merged.len() {
        0 => Node::Empty,
        1 => merged.into_iter().next().unwrap(),
        _ => Node::Row(merged),
    }
}

/// Flatten a node tree into plain text (for \text{} contents).
fn flatten_text(node: &Node) -> String {
    match node {
        Node::Row(items) => items.iter().map(flatten_text).collect(),
        Node::Ident(s) | Node::Upright(s) => s.clone(),
        Node::Empty => String::new(),
        _ => String::new(),
    }
}

/// Classify a single character into an italic identifier or upright literal.
fn classify_char(c: char) -> Node {
    if c.is_ascii_digit() {
        Node::Upright(c.to_string())
    } else if c.is_ascii_alphabetic() {
        Node::Ident(c.to_string())
    } else {
        // Operators and punctuation are upright.
        Node::Upright(c.to_string())
    }
}

// ---------------------------------------------------------------------------
// OMML serialization
// ---------------------------------------------------------------------------

fn serialize(node: &Node, out: &mut String) {
    match node {
        Node::Empty => {}
        Node::Row(items) => {
            for it in items {
                serialize(it, out);
            }
        }
        Node::Ident(s) => {
            run(out, s, false);
        }
        Node::Upright(s) => {
            run(out, s, true);
        }
        Node::Sup(base, sup) => {
            out.push_str("<m:sSup><m:e>");
            serialize(base, out);
            out.push_str("</m:e><m:sup>");
            serialize(sup, out);
            out.push_str("</m:sup></m:sSup>");
        }
        Node::Sub(base, sub) => {
            out.push_str("<m:sSub><m:e>");
            serialize(base, out);
            out.push_str("</m:e><m:sub>");
            serialize(sub, out);
            out.push_str("</m:sub></m:sSub>");
        }
        Node::SubSup(base, sub, sup) => {
            out.push_str("<m:sSubSup><m:e>");
            serialize(base, out);
            out.push_str("</m:e><m:sub>");
            serialize(sub, out);
            out.push_str("</m:sub><m:sup>");
            serialize(sup, out);
            out.push_str("</m:sup></m:sSubSup>");
        }
        Node::Frac(num, den) => {
            out.push_str("<m:f><m:num>");
            serialize(num, out);
            out.push_str("</m:num><m:den>");
            serialize(den, out);
            out.push_str("</m:den></m:f>");
        }
        Node::Rad(degree, body) => {
            out.push_str("<m:rad><m:radPr>");
            if degree.is_none() {
                out.push_str("<m:degHide m:val=\"1\"/>");
            }
            out.push_str("</m:radPr><m:deg>");
            if let Some(d) = degree {
                serialize(d, out);
            }
            out.push_str("</m:deg><m:e>");
            serialize(body, out);
            out.push_str("</m:e></m:rad>");
        }
        Node::Nary(sym, sub, sup, body) => {
            out.push_str("<m:nary><m:naryPr><m:chr m:val=\"");
            xml_escape_into(sym, out);
            out.push_str("\"/><m:limLoc m:val=\"subSup\"/>");
            if sub.is_none() {
                out.push_str("<m:subHide m:val=\"1\"/>");
            }
            if sup.is_none() {
                out.push_str("<m:supHide m:val=\"1\"/>");
            }
            out.push_str("</m:naryPr><m:sub>");
            if let Some(s) = sub {
                serialize(s, out);
            }
            out.push_str("</m:sub><m:sup>");
            if let Some(s) = sup {
                serialize(s, out);
            }
            out.push_str("</m:sup><m:e>");
            serialize(body, out);
            out.push_str("</m:e></m:nary>");
        }
        Node::Delim(open, body, close) => {
            out.push_str("<m:d><m:dPr>");
            out.push_str("<m:begChr m:val=\"");
            xml_escape_into(open, out);
            out.push_str("\"/>");
            out.push_str("<m:endChr m:val=\"");
            xml_escape_into(close, out);
            out.push_str("\"/>");
            out.push_str("</m:dPr><m:e>");
            serialize(body, out);
            out.push_str("</m:e></m:d>");
        }
        Node::Accent(chr, base) => {
            out.push_str("<m:acc><m:accPr><m:chr m:val=\"");
            xml_escape_into(chr, out);
            out.push_str("\"/></m:accPr><m:e>");
            serialize(base, out);
            out.push_str("</m:e></m:acc>");
        }
    }
}

/// Emit an `<m:r>` run. When `upright`, force normal (non-italic) style.
fn run(out: &mut String, text: &str, upright: bool) {
    if text.is_empty() {
        return;
    }
    out.push_str("<m:r>");
    if upright {
        out.push_str("<m:rPr><m:sty m:val=\"p\"/></m:rPr>");
    }
    out.push_str("<m:t xml:space=\"preserve\">");
    xml_escape_into(text, out);
    out.push_str("</m:t></m:r>");
}

fn xml_escape_into(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
}

// ---------------------------------------------------------------------------
// Symbol tables
// ---------------------------------------------------------------------------

fn is_function_name(name: &str) -> bool {
    matches!(
        name,
        "sin" | "cos" | "tan" | "cot" | "sec" | "csc" | "sinh" | "cosh"
            | "tanh" | "coth" | "arcsin" | "arccos" | "arctan" | "log"
            | "ln" | "lg" | "exp" | "det" | "dim" | "ker" | "deg" | "gcd"
            | "hom" | "arg" | "max" | "min" | "sup" | "inf" | "lim"
            | "limsup" | "liminf" | "Pr" | "mod" | "bmod"
    )
}

fn nary_symbol(name: &str) -> &'static str {
    match name {
        "sum" => "\u{2211}",       // ∑
        "prod" => "\u{220F}",      // ∏
        "coprod" => "\u{2210}",    // ∐
        "int" => "\u{222B}",       // ∫
        "iint" => "\u{222C}",      // ∬
        "iiint" => "\u{222D}",     // ∭
        "oint" => "\u{222E}",      // ∮
        "bigcup" => "\u{22C3}",    // ⋃
        "bigcap" => "\u{22C2}",    // ⋂
        "bigoplus" => "\u{2A01}",  // ⨁
        "bigotimes" => "\u{2A02}", // ⨂
        "bigodot" => "\u{2A00}",   // ⨀
        "bigvee" => "\u{22C1}",    // ⋁
        "bigwedge" => "\u{22C0}",  // ⋀
        "bigsqcup" => "\u{2A06}",  // ⨆
        "biguplus" => "\u{2A04}",  // ⨄
        _ => "\u{2211}",
    }
}

fn accent_char(name: &str) -> &'static str {
    match name {
        "hat" | "widehat" => "\u{0302}",   // ̂
        "bar" | "overline" => "\u{0304}",  // ̄
        "vec" => "\u{20D7}",               // ⃗
        "tilde" | "widetilde" => "\u{0303}",
        "dot" => "\u{0307}",
        "ddot" => "\u{0308}",
        "check" => "\u{030C}",
        "acute" => "\u{0301}",
        "grave" => "\u{0300}",
        "breve" => "\u{0306}",
        _ => "\u{0302}",
    }
}

fn delim_symbol(name: &str) -> String {
    let s = match name {
        "lfloor" => "\u{230A}",
        "rfloor" => "\u{230B}",
        "lceil" => "\u{2308}",
        "rceil" => "\u{2309}",
        "langle" => "\u{27E8}",
        "rangle" => "\u{27E9}",
        "lbrace" => "{",
        "rbrace" => "}",
        "vert" | "lvert" | "rvert" | "mid" => "|",
        "Vert" | "lVert" | "rVert" | "parallel" => "\u{2016}",
        "uparrow" => "\u{2191}",
        "downarrow" => "\u{2193}",
        _ => "",
    };
    s.to_string()
}

/// Map a LaTeX command name to a Unicode symbol (Greek letters + operators).
fn symbol_for(name: &str) -> Option<&'static str> {
    let s = match name {
        // Lowercase Greek
        "alpha" => "\u{03B1}",
        "beta" => "\u{03B2}",
        "gamma" => "\u{03B3}",
        "delta" => "\u{03B4}",
        "epsilon" => "\u{03F5}",
        "varepsilon" => "\u{03B5}",
        "zeta" => "\u{03B6}",
        "eta" => "\u{03B7}",
        "theta" => "\u{03B8}",
        "vartheta" => "\u{03D1}",
        "iota" => "\u{03B9}",
        "kappa" => "\u{03BA}",
        "lambda" => "\u{03BB}",
        "mu" => "\u{03BC}",
        "nu" => "\u{03BD}",
        "xi" => "\u{03BE}",
        "omicron" => "\u{03BF}",
        "pi" => "\u{03C0}",
        "varpi" => "\u{03D6}",
        "rho" => "\u{03C1}",
        "varrho" => "\u{03F1}",
        "sigma" => "\u{03C3}",
        "varsigma" => "\u{03C2}",
        "tau" => "\u{03C4}",
        "upsilon" => "\u{03C5}",
        "phi" => "\u{03D5}",
        "varphi" => "\u{03C6}",
        "chi" => "\u{03C7}",
        "psi" => "\u{03C8}",
        "omega" => "\u{03C9}",
        // Uppercase Greek
        "Gamma" => "\u{0393}",
        "Delta" => "\u{0394}",
        "Theta" => "\u{0398}",
        "Lambda" => "\u{039B}",
        "Xi" => "\u{039E}",
        "Pi" => "\u{03A0}",
        "Sigma" => "\u{03A3}",
        "Upsilon" => "\u{03A5}",
        "Phi" => "\u{03A6}",
        "Psi" => "\u{03A8}",
        "Omega" => "\u{03A9}",
        // Binary operators / relations
        "times" => "\u{00D7}",
        "div" => "\u{00F7}",
        "pm" => "\u{00B1}",
        "mp" => "\u{2213}",
        "cdot" => "\u{22C5}",
        "cdots" => "\u{22EF}",
        "ldots" => "\u{2026}",
        "dots" => "\u{2026}",
        "vdots" => "\u{22EE}",
        "ddots" => "\u{22F1}",
        "ast" => "\u{2217}",
        "star" => "\u{22C6}",
        "circ" => "\u{2218}",
        "bullet" => "\u{2219}",
        "oplus" => "\u{2295}",
        "ominus" => "\u{2296}",
        "otimes" => "\u{2297}",
        "oslash" => "\u{2298}",
        "odot" => "\u{2299}",
        "leq" | "le" => "\u{2264}",
        "geq" | "ge" => "\u{2265}",
        "neq" | "ne" => "\u{2260}",
        "equiv" => "\u{2261}",
        "approx" => "\u{2248}",
        "cong" => "\u{2245}",
        "sim" => "\u{223C}",
        "simeq" => "\u{2243}",
        "propto" => "\u{221D}",
        "ll" => "\u{226A}",
        "gg" => "\u{226B}",
        "subset" => "\u{2282}",
        "supset" => "\u{2283}",
        "subseteq" => "\u{2286}",
        "supseteq" => "\u{2287}",
        "in" => "\u{2208}",
        "notin" => "\u{2209}",
        "ni" => "\u{220B}",
        "cup" => "\u{222A}",
        "cap" => "\u{2229}",
        "setminus" => "\u{2216}",
        "emptyset" => "\u{2205}",
        "varnothing" => "\u{2205}",
        "forall" => "\u{2200}",
        "exists" => "\u{2203}",
        "nexists" => "\u{2204}",
        "neg" | "lnot" => "\u{00AC}",
        "land" | "wedge" => "\u{2227}",
        "lor" | "vee" => "\u{2228}",
        "rightarrow" | "to" => "\u{2192}",
        "leftarrow" | "gets" => "\u{2190}",
        "leftrightarrow" => "\u{2194}",
        "Rightarrow" | "implies" => "\u{21D2}",
        "Leftarrow" => "\u{21D0}",
        "Leftrightarrow" | "iff" => "\u{21D4}",
        "mapsto" => "\u{21A6}",
        "longrightarrow" => "\u{27F6}",
        "longleftarrow" => "\u{27F5}",
        "uparrow" => "\u{2191}",
        "downarrow" => "\u{2193}",
        "partial" => "\u{2202}",
        "nabla" => "\u{2207}",
        "infty" => "\u{221E}",
        "aleph" => "\u{2135}",
        "hbar" => "\u{210F}",
        "ell" => "\u{2113}",
        "Re" => "\u{211C}",
        "Im" => "\u{2111}",
        "wp" => "\u{2118}",
        "prime" => "\u{2032}",
        "angle" => "\u{2220}",
        "triangle" => "\u{25B3}",
        "square" => "\u{25A1}",
        "int" => "\u{222B}",
        "nsum" => "\u{2211}",
        "surd" => "\u{221A}",
        "perp" => "\u{22A5}",
        "parallel" => "\u{2225}",
        "cong2" => "\u{2245}",
        "degree" => "\u{00B0}",
        "sum" => "\u{2211}",
        "prod" => "\u{220F}",
        "leftrightarrows" => "\u{21C4}",
        "rightleftharpoons" => "\u{21CC}",
        "top" => "\u{22A4}",
        "bot" => "\u{22A5}",
        "dagger" => "\u{2020}",
        "ddagger" => "\u{2021}",
        _ => return None,
    };
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_superscript() {
        let omml = latex_to_omml("x^2");
        assert!(omml.contains("<m:sSup>"));
        assert!(omml.contains("<m:oMath>"));
    }

    #[test]
    fn fraction() {
        let omml = latex_to_omml("\\frac{a}{b}");
        assert!(omml.contains("<m:f>"));
        assert!(omml.contains("<m:num>"));
        assert!(omml.contains("<m:den>"));
    }

    #[test]
    fn sqrt() {
        let omml = latex_to_omml("\\sqrt{x+1}");
        assert!(omml.contains("<m:rad>"));
        assert!(omml.contains("degHide"));
    }

    #[test]
    fn greek_and_sum() {
        let omml = latex_to_omml("\\sum_{i=1}^{n} \\alpha_i");
        assert!(omml.contains("<m:nary>"));
        assert!(omml.contains("\u{2211}"));
        assert!(omml.contains("\u{03B1}"));
    }
}
