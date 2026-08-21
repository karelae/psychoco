Branches should be based on main and never another branch, the main branch should always be updated before to make sure everything is up to date.

All branches should have this structure: type/description.

where type is one of the following:
- `feature` (new feature or enhancement)
- `bugfix` (bug fix or correction)
- `hotfix` (critical fix that should be applied immediately)
- `refactor` (code refactoring or cleanup)
- `docs` (documentation changes)
- `test` (test code or test data)
- `chore` (maintenance tasks, dependencies, build scripts, etc.)

where description is a concise summary of the changes in the branch, using lowercase letters and hyphens instead of spaces.

examples:
- `feature/add-user-authentication`
- `bugfix/fix-null-pointer-exception-in-user-service`
- `hotfix/fix-critical-security-vulnerability`
- `refactor/clean-up-deprecated-code`
