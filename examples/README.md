# Example Working Directory

This is a practice project for **lite-code-agent**. Point the agent's working directory (`WORKDIR`)
here to safely demonstrate its capabilities on an isolated mini-project without touching the main
repository.

## Contents

- `sum.js` — A small module that sums an array of numbers.
- `sum.test.js` — An assertion script that requires no test framework.
- `package.json` — Provides the `npm test` script.

## Tasks to Try with the Agent

- "Read sum.js and tell me what it does." (demonstrates `read_file`)
- "Add an `average(numbers)` function to sum.js and export it." (demonstrates `edit_file`, requires authorization)
- "Run npm test and see if it passes." (demonstrates `run_command`, requires authorization)
- "Create a new file max.js that implements finding the maximum value." (demonstrates `write_file`, requires authorization)

## Usage

From the project root, set `WORKDIR` to this directory and start the agent:

```bash
WORKDIR=./examples pnpm start
```
