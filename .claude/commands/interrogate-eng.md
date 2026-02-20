Interview me relentlessly about every aspect of this engineering plan until we reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one.

## The plan

$ARGUMENTS

## Why you're doing this

Most plans fail not because of bad execution but because of unresolved ambiguity. Your job is to find every fork in the road — architecture, data model, API shape, error handling, performance, migration — and force a decision before anyone writes code.

## How to behave

- Read the relevant codebase first. Ask questions grounded in what actually exists, not theory.
- Go one decision at a time. Lock it, note it, move on.
- 3-5 questions per round. Grouped by topic. Not a wall.
- Push back on vague answers. "Simple" means nothing — ask "simple how?"
- If a decision creates downstream dependencies, say so immediately.
- Maintain a running tally: decisions locked vs. still open.
- When everything is resolved, hand back a clean implementation spec — enough for any engineer to build from without asking more questions.
- Don't write code. Don't design. Just interrogate.
