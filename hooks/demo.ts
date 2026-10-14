// A fixed diff for `/hunks demo`: lets the pane be seen and tested without a repository.
export const DEMO_DIFF = `diff --git a/src/server.js b/src/server.js
index 1111111..2222222 100644
--- a/src/server.js
+++ b/src/server.js
@@ -5,6 +5,14 @@ const PORT = process.env.PORT || 3000;
 
 app.use(express.json());
 
+app.use((req, res, next) => {
+  const start = Date.now();
+  res.on('finish', () => {
+    console.log(\`\${req.method} \${req.originalUrl} \${res.statusCode} \${Date.now() - start}ms\`);
+  });
+  next();
+});
+
 let todos = [
   { id: 1, title: 'Learn Express', done: false },
   { id: 2, title: 'Try Warp code review', done: false },
@@ -28,16 +36,19 @@ app.get('/todos/:id', (req, res) => {
 app.post('/todos', (req, res) => {
   const { title } = req.body;
-  if (!title) return res.status(400).json({ error: 'title required' });
+  if (!title || title.length < 3) return res.status(400).json({ error: 'title must be 3+ chars' });
   const todo = { id: nextId++, title, done: false };
   todos.push(todo);
   res.status(201).json(todo);
 });
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1,3 @@
+# Demo
+
+A fixture for the review pane.
`

/** `/hunks demo big`: many files, a few hunks each, to see folding and long lists. */
export const bigDemoDiff = (files = 40, hunks = 3): string =>
  Array.from({ length: files }, (_, f) => {
    const dir = ['src', 'src/routes', 'src/lib', 'test'][f % 4]
    const path = `${dir}/module${f}.js`
    const body = Array.from({ length: hunks }, (_, h) => {
      const at = h * 30 + 1
      return `@@ -${at},3 +${at},4 @@\n const a${h} = ${f}\n+const b${h} = a${h} + ${h}\n const c${h} = ${h}\n export { a${h} }\n`
    }).join('')
    return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${body}`
  }).join('')
