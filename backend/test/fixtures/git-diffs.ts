export const SIMPLE_MODIFY_DIFF = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import { Hono } from 'hono';
+import { cors } from 'hono/cors';

 const app = new Hono();`;

export const NEW_FILE_DIFF = `diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return 'world';
+}`;

export const DELETE_FILE_DIFF = `diff --git a/src/old-file.ts b/src/old-file.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/old-file.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function goodbye() {
-  return 'world';
-}`;

export const RENAME_DIFF = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
index abc1234..def5678 100644`;

export const QUOTED_PATH_DIFF = `diff --git "a/path with spaces/file.ts" "b/path with spaces/file.ts"
index abc1234..def5678 100644
--- "a/path with spaces/file.ts"
+++ "b/path with spaces/file.ts"`;

export const NUMSTAT_OUTPUT = `10\t5\tsrc/app.ts
3\t0\tsrc/new-file.ts
0\t15\tsrc/old-file.ts`;

export const SHORTSTAT_OUTPUT = ` 3 files changed, 13 insertions(+), 20 deletions(-)`;

export const SHORTSTAT_SINGLE = ` 1 file changed, 1 insertion(+)`;
