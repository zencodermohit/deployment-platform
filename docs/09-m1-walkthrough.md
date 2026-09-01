# 09 — M1 Walkthrough (plain English)

This explains what M1 is, what every file does, and why. No AWS knowledge needed.
If you already know all this, skip to [Running it](#running-it).

## What M1 is

One program, in one container, that does exactly this:

```
a .tar.gz of someone's website  ->  [ builder ]  ->  a folder of files ready to serve
```

That's it. No AWS, no database, no queue, no website of your own. Just the piece
that takes source code and turns it into a built site.

**Why start here?** This is the part that can actually defeat us. Building a
dashboard is work you already know how to do. Making a container safely run a
stranger's code is not. If it turns out to be harder than expected, better to
find out on day four than in week six.

## The vocabulary

A few words that will otherwise trip you up:

| Word | What it actually means |
|---|---|
| **Container** | A sealed box that runs a program. It has its own filesystem and can't touch your computer. Docker makes and runs them. |
| **Image** | The recipe for a container. You build an image once, then start many containers from it. |
| **Tarball** | A `.tar.gz` file. Like a `.zip` — many files squashed into one. |
| **Artifact** | The finished output of a build. For us: a folder of HTML, CSS, JS. |
| **Exit code** | A number a program returns when it ends. `0` means success; anything else is a specific failure. |
| **stdout** | Where a program prints. We print JSON so a machine can read it later. |
| **Monorepo** | One folder holding several small projects that use each other. |
| **Bundling** | Squashing many source files into one file so it's easier to ship. |

## The folder layout

```
packages/core/        Shared code. Rules and definitions, no action.
apps/builder/         The actual program that does the building.
docker/builder/       The recipe for the container image.
tests/                Proof that all of it works.
scripts/              Convenience commands you run by hand.
```

The split matters: `core` holds things the AWS side will *also* need later
(what counts as a Vite project, what each exit code means). Putting them in a
shared place now means we don't rewrite them in M3.

## What each file does

### The shared rules — `packages/core/`

**`errors.ts`** — a list of numbers.

```
0  = it worked            13 = the build command failed
10 = bad source file      14 = build ran but produced nothing
11 = we don't support     17 = took too long
     this framework       20 = you configured it wrong
12 = npm install failed   137 = the system killed it (out of memory)
```

Why bother? Because when a container dies, **the exit code is the only thing
that survives**. Logs might not have been flushed. Later on, AWS reads this
number to work out what to tell the user. So it's a contract, not a detail.

**`logger.ts`** — printing, done carefully. Three things it does that a plain
`console.log` doesn't:

1. Prints **JSON**, one object per line, so a machine can filter it later.
2. **Hides secrets.** Give it a list of secret strings and it replaces them with
   `[redacted]` everywhere. Build tools print their whole environment more often
   than you'd think.
3. **Refuses to print more than 10 MB.** A malicious repo could `console.log` in
   an infinite loop. On AWS you pay per gigabyte of logs. So there's a hard stop.

**`config.ts`** — reads settings from environment variables and checks them.
If you set `BUILD_TIMEOUT_SEC=banana` it stops immediately with a clear message.
Failing in the first second beats failing eight minutes in.

It also generates the deployment ID: `dep_` plus 32 random hex characters. Random,
**not** `dep_1`, `dep_2` — these end up in public URLs, and guessable URLs mean
anyone could find other people's sites.

**`frameworks.ts`** — the table that decides what kind of project this is.

```
sees "vite" in the dependencies      -> run: npm run build, look in: dist/
sees "react-scripts"                 -> run: npm run build, look in: build/
sees "next" AND output:'export'      -> run: npm run build, look in: out/
sees "next" WITHOUT output:'export'  -> REFUSE, and explain why
sees no package.json but an index.html -> no build needed, serve as-is
anything else                        -> REFUSE
```

Two safety rules hide in there:

- **The build command comes from our table, never from the repo.** If we ran
  whatever was in the repo's `scripts.build`, someone could put
  `rm -rf / && curl evil.com` in there.
- **We read `next.config.js` as plain text, never run it.** Running it to find
  out how to run the project would mean executing a stranger's code before we've
  decided anything about sandboxing.

**`content-types.ts`** — decides what to label each file. If you serve an HTML
file labelled as `application/octet-stream`, the browser downloads it instead of
showing it. Also decides caching: files with a hash in the name
(`app.4f3a9b2c.js`) can be cached forever because a change makes a new name;
`index.html` must always be re-checked, or a rollback would be invisible.

### The program — `apps/builder/`

**`exec.ts`** — runs `npm install` and `npm run build`. Three deliberate choices:

- **Never use a shell.** Commands go as a list: `["npm", "run", "build"]`. If a
  branch were named `main; rm -rf /`, a shell would treat the `;` as "now run
  this next command". A list treats the whole thing as one meaningless string.
- **Build the child's environment by hand.** We don't pass our own environment
  down. Later this process holds an access token; a build script that dumps its
  environment must not find it.
- **Every command has a stopwatch.** Politely ask it to stop (SIGTERM), then
  five seconds later stop asking (SIGKILL).

**`phases/`** — seven steps, one file each:

| Step | File | What happens |
|---|---|---|
| 1 | `fetch.ts` | Get the tarball. Check its size *before* opening it. |
| 2 | `extract.ts` | Unpack it — carefully. See below. |
| 3 | `inspect.ts` | Read `package.json`, decide which framework. |
| 4 | `install.ts` | `npm ci` (or `npm install` with no lockfile). |
| 5 | `build.ts` | Run the build command from the table. |
| 6 | `collect.ts` | Find the output folder, check it isn't empty. |
| 7 | `publish.ts` | Copy the files out, write a manifest. |

**`extract.ts` is the dangerous one.** A tar file can contain an entry named
literally `../../../etc/passwd`. Unpack it naively and you've overwritten a
system file — this is called **zip slip** and it's the classic bug here. We:

- reject any path with `..` in it, or starting with `/`, or like `C:\`
- reject anything that isn't a plain file or folder (no symlinks — a symlink to
  `/etc/passwd` would let the build read your host's files)
- **count the bytes while unpacking, not after.** 1 MB of compressed data can
  expand to 100 GB. That's a **zip bomb**. Checking afterwards is too late,
  because "afterwards" is when your disk is already full.

There's a real bug in this file's history worth knowing about. The first version
*threw an error* from inside the unpacking callback. It turns out the tar library
calls that callback from deep inside a stream, so the error escaped sideways
instead of being caught — the program hung instead of failing. **The test caught
it.** The fix: record the problem, stop accepting files, and report it once
unpacking finishes.

**`health.ts`** — the `doctor` command. Checks node is new enough, npm works,
we're not running as root, the folders are writable, tar loads.

A note on Docker's `HEALTHCHECK` instruction: it exists for programs that run
forever (a web server), where Docker re-checks every 30 seconds. Our container
runs once and exits, so a runtime healthcheck would be pointless. Instead we run
`doctor` **while building the image** — so a broken image fails `docker build`
rather than failing mysteriously on someone's first real deployment.

**`main.ts`** — glues it together, and holds the **watchdog**: a timer that kills
everything if the build overruns. Two timers, actually — one per command, one for
the whole run. Belt and braces, because Fargate has no timeout setting of its own
and a genuinely stuck process won't kill itself.

### The container — `docker/builder/Dockerfile`

Three stages. The first installs dependencies, the second type-checks and squashes
everything into one 158 KB file, and the third copies **only that one file** into
a clean image.

Why? The final image has no source code, no TypeScript, no build tools, no
`node_modules`. If someone breaks out of the build, there's less lying around for
them to use. It's also much smaller, so it starts faster.

The last line before the entrypoint is `USER node` — **never run as root.**

## Running it

```bash
npm install          # once
npm run fixtures     # make the test .tar.gz files
npm run build        # bundle the builder
npm test             # 57 tests, ~11 seconds, no network needed
```

Run a build without Docker:

```bash
node apps/builder/dist/builder.mjs tests/fixtures/tarballs/static-ok.tar.gz
```

You'll need `OUTPUT_DIR` set. On PowerShell:

```powershell
$env:OUTPUT_DIR = "$PWD\.out"; $env:WORK_DIR = "$PWD\.work"
node apps/builder/dist/builder.mjs tests/fixtures/tarballs/static-ok.tar.gz
```

With Docker (start Docker Desktop first):

```bash
npm run docker:build
./scripts/run-build.ps1 -Fixture static-ok      # PowerShell
./scripts/run-build.sh static-ok                # bash
```

The run scripts apply the same limits Fargate will: 1 CPU, 2 GB memory, 512
processes, no extra privileges. Add `-NoNetwork` / `NO_NETWORK=1` for a static
site to prove it needs no internet at all.

## Reading the output

Every line is JSON. The last line is always the result:

```json
{"ts":"...","level":"info","phase":"result","deploymentId":"dep_static1",
 "msg":"deployment deployed","status":"DEPLOYED","exitCode":0,"durationMs":412,
 "framework":"static","fileCount":3,"totalBytes":274}
```

Pipe it through `jq` to read it comfortably:

```bash
node apps/builder/dist/builder.mjs ... | jq -r '"\(.phase)\t\(.msg)"'
```

## What's deliberately missing

No AWS. No S3, no DynamoDB, no queue, no status callbacks. `publish.ts` copies
files to a local folder instead of uploading them.

That's not laziness — it's the seam. `publish.ts` already does everything the S3
upload will need: 8 files at a time, the right `Content-Type` and `Cache-Control`
per file, a manifest. In M2 we swap `copyFile` for `PutObject` and nothing else
in that file changes.

Two other marked seams: `config.ts` has a `BUILDER_MODE` switch that currently
only accepts `local`, and `fetch.ts` reads a local path where it will later fetch
a presigned URL.

## Where M1 stands

| Exit criterion | Status |
|---|---|
| A real Vite repo produces a correct `dist/` | **Passing** — 21.5s, real `npm install`, hashed assets in `assets/`, `/src/main.js` rewritten |
| A fixture with a failing build exits 13 | **Passing** — 14.5s, and publishes nothing |
| The watchdog kills an overrunning build | **Passing** — exits 17 at a 5s deadline |
| Type-checks clean under strict TypeScript | **Passing** |
| Unit + integration tests | **57/57, ~11s**, no network needed |
| End-to-end tests | **3/3, ~44s**, needs network (`npm run test:e2e`) |
| Same thing via `docker run` | **Not yet verified** — the Docker daemon wasn't running. Start Docker Desktop, then `npm run docker:build`. |

Everything is verified through Node. The Docker image is written but unbuilt, so
treat that one row as genuinely unproven until you run it.

## Next

M2 — artifacts and delivery. S3 buckets, CloudFront, the edge function that maps
a hostname to a folder. That's the highest-risk milestone, which is why it comes
second, while there's still energy for it.
