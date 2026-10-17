# Publishing checklist

Use this checklist before you make the repository public or push it to a new public remote. It complements the rules in [AGENTS.md](../../AGENTS.md): the working tree may be clean while **older commits** still contain private deployment details.

## 1. Scan the working tree

```bash
git grep -nE '<your-domain>|<your-server-ip>|/Users/<you>|/home/<you>'
```

Replace the placeholders with the real values you used while deploying. Everything in the tree should use `example.com`, documentation IP ranges and placeholder paths.

## 2. Scan the full history

```bash
# Secret patterns across every reachable commit.
gitleaks detect --source . --log-opts=--all

# Domains and IPv4 addresses that are not reserved examples.
git log -p --all | grep -oE '[a-z0-9.-]+\.[a-z]{2,}' | sort | uniq -c | sort -rn | less
git log -p --all | grep -oE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' | sort | uniq -c | sort -rn

# Which commits introduced a specific value.
git log --all --format='%h %ad %s' --date=short -S '<value>'
```

Also review home directory paths, SSH targets, account names and any token-like strings.

## 3. Choose how to publish

**A. Fresh public history (recommended if anything turned up).** Keep the private repository as it is. Then create the public repository from a clean snapshot:

```bash
git archive --format=tar HEAD | (mkdir ../reach-public && tar -x -C ../reach-public)
cd ../reach-public && git init && git add -A && git commit -m "Initial public release"
```

**B. Rewrite history.** Use `git filter-repo --replace-text replacements.txt`, with one `literal==>replacement` pair per line. Then force-push every branch and tag. Every existing clone, fork and open pull request must be re-cloned, and GitHub may keep cached views of old commits until they are garbage-collected.

## 4. After publishing

- Run the scans from steps 1 and 2 again on the public repository.
- Rotate any credential that ever appeared in history, even if it was removed later.
- Check that `.reach/`, `deploy/*.env`, `deploy/engines.json` and `deploy/data/` are still ignored.
- Check the repository description, topics and Release notes for private details.
