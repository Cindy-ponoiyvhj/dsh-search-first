# dsh-search-first

**Look before you build.**

An agent with a task in hand tends to start building immediately — and then
re-implements something that already exists, badly. This bundle makes searching
for prior art the first step instead of an afterthought.

## What it does

Two halves, both optional:

1. **A system-prompt rule.** Adds one section to the assembled system prompt
   telling the agent to search for an existing implementation, package or
   documented approach before it writes, edits, runs or installs anything, and
   to reuse what it finds. This alone changes behaviour: the rule is read on
   every assembly.
2. **An optional hard guard.** With `strict: true`, the first hands-on call in
   a turn (`write`, `edit`, `ops_bash`, `plugin_manager`, `present`, …) is
   refused until a search tool has actually run in that same turn. The refusal
   carries the reason and the retry instruction, so the agent corrects itself
   on the next step instead of dead-ending.

The rule is always on; the guard is off by default, because a one-line typo fix
should not require a web search.

## Install

```sh
dsh plugin add dsh-search-first
```

or install the bundle from the plugin market.

## Config

Every key is optional and can be set on the bundle row:

```yaml
- insert:
    - id: search-first
      name: 'dsh-search-first'
      config:
        enabled: true      # false removes both the rule and the guard
        order: 130         # position among system-prompt sections
        strict: false      # true = deny hands-on tools until a search ran
        rule: |            # replaces the default rule text
          ...
        searchTools: [web_search, memory_search]   # what counts as a search
        guardedTools: [write, edit, ops_bash]      # what the guard holds back
        allowTools: [ops_bash]                     # guard exceptions
```

`searchTools` and `guardedTools` accept exact names or prefixes: an entry
`ops_bash` also matches `ops_bash_async`.

## Behaviour notes

- The guard is per turn, per session. Once a search tool runs, every guarded
  tool is allowed for the rest of that turn.
- The guard never blocks search tools themselves, and never blocks tools in
  `allowTools`.
- Subagents inherit the rule through the system prompt but keep their own turn
  state.
- The rule section is registered once; if the `systemPrompt` service mounts
  late, registration retries for up to 20 seconds.

## Why

Rebuilding a solved problem is the expensive path. Finding the mature solution
first is the cheap one — in tokens, in time, and in bugs.

## License

MIT