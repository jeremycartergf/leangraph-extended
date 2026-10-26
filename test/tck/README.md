# openCypher TCK Tests

This directory contains the openCypher Technology Compatibility Kit (TCK) test infrastructure.

## Setup

The TCK feature files are not included in the repository and must be downloaded from the official openCypher project.

### Download TCK Files

```bash
npm run tck:setup
```

This sparse-checks-out only `tck/features` into `test/tck/openCypher/` (gitignored), pinned
to the openCypher commit the baseline was checked against. Re-running it is safe; set
`TCK_COMMIT=<sha>` to try a different commit.

After setup, the directory structure should be:

```
test/tck/
├── openCypher/
│   └── tck/
│       └── features/
│           ├── clauses/
│           ├── expressions/
│           └── ...
├── tck.test.ts
├── run-test.ts
└── README.md
```

## Running Tests

```bash
# Run all TCK tests
npm test

# Run specific TCK test by number or name
npm run tck 'Return6|11'
npm run tck 'Counting matches'

# List matching tests without running
npm run tck 'Match3' -- --list

# Show generated SQL for debugging
npm run tck 'Return6' -- --sql

# Run even if test is in known-failing list
npm run tck 'SomeTest' -- --force

# Run all tests including known failing ones
TCK_TEST_ALL=1 npm test

# Check which failing tests now pass
npm run tck:check-fixed
```

## Source

- Repository: https://github.com/opencypher/openCypher
- TCK Features: https://github.com/opencypher/openCypher/tree/main/tck/features
