# Tools Cheat-sheet

## lizard (multi-language, primary recommendation)

```bash
pip install lizard
lizard .                          # whole tree
lizard src/ -l python -l java     # filter languages
lizard . -C 10 -a 5 -L 40         # thresholds: CCN, args, NLOC
lizard . --csv                    # machine readable
lizard . -Eduplicate              # also find clones
```

Output columns: NLOC, CCN, token, PARAM, length, location, file, function.

## radon (Python)

```bash
pip install radon
radon cc path/ -a -s              # CC with average + show all
radon cc path/ -n C               # only rank C or worse
radon mi path/ -s                 # Maintainability Index
radon hal path/                   # Halstead
radon raw path/                   # LOC / SLOC / comments / blank
```

Ranks A–F based on CC.

## complexipy (Python cognitive)

```bash
pip install complexipy
complexipy .
complexipy path/ --max-complexity-allowed 15 --failed
```

## ESLint (JS/TS)

```bash
npx eslint --rule 'complexity: ["error", 10]' src/
# or with sonarjs plugin for cognitive:
# "sonarjs/cognitive-complexity": ["error", 15]
```

## cccc (cognitive + cyclomatic, multi)

Single binary, JSON output. Supports TS/JS, Rust, Go, PHP.

## SonarQube / SonarCloud

Full platform: complexity, cognitive, debt ratio, quality gates, PR decoration. Use sonar-scanner CLI against a running server or cloud.

## Manual / AST fallback

When tools unavailable, parse AST (Python ast, tree-sitter, etc.) and apply the counting rules from metrics-detail.md.
