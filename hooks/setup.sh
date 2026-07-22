#!/bin/sh
# Run once after cloning to enable the versioned git hooks (the pre-commit test gate).
# Safe to re-run.
git config core.hooksPath hooks
chmod +x hooks/pre-commit
echo "Lexigo git hooks enabled (core.hooksPath = hooks). Commits now run: node --test"
