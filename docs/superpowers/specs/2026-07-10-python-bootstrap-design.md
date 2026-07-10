# Automatic Python Bootstrap Design

## Goal

Make `./install.sh` complete without stopping when macOS has no compatible
Python. The installer asks for administrator authorization once, immediately
after startup, then detects or installs Python and continues through ruyiPage
and the remaining environment setup.

## User Experience

1. `./install.sh` prints why administrator authorization is required.
2. It immediately runs `sudo -v`, so the password prompt appears before any
   downloads, compilation, or environment checks.
3. If Python 3.10 or newer already exists, it is reused.
4. Otherwise the installer downloads and installs the pinned official Python
   3.12.10 macOS universal2 package.
5. After installation, the script verifies Python again and continues without
   asking the user to restart the terminal or rerun `./install.sh`.
6. ruyiPage is installed into `.runtime/ruyipage-venv`; the system Python
   installation is used only as the base interpreter.

`run.sh` keeps its existing non-privileged bootstrap behavior and must not ask
for an administrator password on every run.

## Architecture

### Install Entry Point

`install.sh` and the generated release `install.sh` call a new
`bootstrap_macos_install_runtime` function from `scripts/bootstrap-macos.sh`.
That function performs these steps in order:

1. Confirm the host is macOS.
2. Acquire administrator authorization with `sudo -v`.
3. Reuse an administrator-trusted Python, or install the pinned official
   Python package.
4. Stop the authorization keepalive and invalidate the sudo timestamp.
5. Ensure Node 18 or newer is available without administrator privileges.

The existing `bootstrap_macos_runtime` function remains the lightweight entry
point used by `run.sh`.

### Python Detection

The bootstrap checks candidates in this order:

1. `PYTHON_BOOTSTRAP_EXECUTABLE`, when explicitly configured.
2. `python3`.
3. `python`.
4. `/usr/local/bin/python3`.
5. `/Library/Frameworks/Python.framework/Versions/3.12/bin/python3`.

A candidate is resolved to its real absolute path before it is executed. The
binary and every directory in its resolved path must be owned by root and must
not be group- or world-writable. This prevents a user-replaceable interpreter
from running while the sudo timestamp is valid. A candidate that passes this
trust gate is accepted only when `--version` reports Python 3.10 or newer;
otherwise the pinned official Python is installed. The selected interpreter is
passed explicitly to the Node ruyiPage runtime installer, which uses it only to
create the project-local virtual environment.

### Official Installer

The fallback runtime, package URL, SHA-256 digest, and signing identity are
fixed together in the source. The package URL is:

`https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg`

`PYTHON_BOOTSTRAP_EXECUTABLE` may nominate an existing interpreter, but it is
still subject to the administrator-trust and version checks above. It cannot
override the pinned download.

The package is downloaded into `.runtime/downloads` using HTTPS-only redirects,
a temporary `.part` file, and an atomic rename after a successful transfer.
Before installation:

1. Its SHA-256 must equal the pinned digest.
2. It is copied with mode `0600` into a root-owned private directory under
   `/var/tmp`.
3. The root-private copy's SHA-256 is checked again.
4. `pkgutil --check-signature` must succeed on that private copy. The leaf
   certificate subject must be exactly `Developer ID Installer: Python Software
   Foundation`, followed by a syntactically valid 10-character Team ID. The
   Team ID is read from each verified package instead of being persisted, so a
   future Python Software Foundation certificate rotation does not require a
   code change.

The package is installed with:

`sudo installer -pkg <package> -target /`

The root-private copy cannot be replaced by the invoking user between
verification and installation. It is removed after installation or by the
failure trap. The installer then re-runs trusted Python detection. A successful
`installer` exit without a supported interpreter is treated as a hard failure.

## Security And Privilege Boundary

- The administrator password is handled exclusively by `sudo`; the project
  never reads, stores, pipes, or logs it.
- Authorization is requested once at the start. A background `sudo -n` keepalive
  covers only trusted Python detection, download, verification, and installation.
  It is stopped immediately afterward and `sudo -k` invalidates the timestamp
  before Node, ruyiPage, compilation, or project setup runs.
- Privileged commands use absolute system paths and non-interactive `sudo -n`.
  Only staging, verifying, installing, and cleaning the pinned Python.org
  package run with administrator privileges.
- Node, ruyiPage, reports, profiles, and generated project files remain under
  the project directory or the current user account.
- Download, digest, or signature failure stops before `sudo installer`.
- Existing compatible Python installations are reused only when their resolved
  path passes the root ownership and write-permission checks.

## Failure Handling

- Unsupported macOS/CPU state: stop with a concrete diagnostic.
- User declines or fails sudo authorization: stop before downloads.
- Download failure: remove only the incomplete `.part` file and report the URL.
- Digest or signature mismatch: do not install; clean the root-private copy and
  retain the user-owned cached package path for inspection.
- Installer failure: report the `installer` exit and stop.
- Python still unavailable after installation: report all checked paths and
  stop.
- ruyiPage installation failure: preserve the existing isolated-venv error
  behavior.

## Tests

Add a Windows-runnable regression test that inspects the shell bootstrap and
generated release installer:

- `install.sh` and generated `install.sh` use
  `bootstrap_macos_install_runtime`.
- `run.sh` and generated `run.sh` continue using
  `bootstrap_macos_runtime`.
- The bootstrap runs `sudo -v` before Python/Node installation work.
- Python 3.12.10 and the official Python.org package URL are pinned.
- The SHA-256 is pinned; the verified leaf certificate must have the exact
  Python Software Foundation subject and a valid Team ID format.
- Existing interpreters pass the ownership and path-permission trust gate before
  their version command is executed.
- `sudo installer -pkg ... -target /` is present.
- The sudo keepalive is stopped and the timestamp invalidated before Node setup.
- Supported-version detection requires Python 3.10 or newer.
- The release copy list includes `scripts/bootstrap-macos.sh`.

Verification also includes:

- Root and generated shell `bash -n`.
- Existing ruyiPage runtime, protocol, browser backend, profile, release, and
  Python flow tests.
- `npm run check` on Windows for non-macOS reporting.
- A real `./install.sh` run on the macOS test machine with Python temporarily
  absent from `PATH`.

## Documentation

Update `README.md`, `docs/PROJECT.md`, and generated release documentation to
state that `./install.sh` requests administrator authorization immediately and
automatically installs signed Python 3.12.10 when Python 3.10+ is unavailable.
