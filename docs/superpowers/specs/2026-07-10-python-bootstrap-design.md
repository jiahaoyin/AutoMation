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
3. Ensure a supported Python is available.
4. Ensure Node 18 or newer is available.

The existing `bootstrap_macos_runtime` function remains the lightweight entry
point used by `run.sh`.

### Python Detection

The bootstrap checks candidates in this order:

1. `PYTHON_BOOTSTRAP_EXECUTABLE`, when explicitly configured.
2. `python3`.
3. `python`.
4. `/usr/local/bin/python3`.
5. `/Library/Frameworks/Python.framework/Versions/3.12/bin/python3`.

A candidate is accepted only when `--version` reports Python 3.10 or newer.
The selected interpreter's directory is prepended to `PATH`, allowing the
existing Node ruyiPage runtime installer to create the project virtual
environment without additional configuration.

### Official Installer

The default pinned runtime is Python 3.12.10. Configuration is exposed through
environment variables for controlled testing or future maintenance:

- `PYTHON_BOOTSTRAP_VERSION`
- `PYTHON_BOOTSTRAP_PKG_URL`
- `PYTHON_BOOTSTRAP_EXECUTABLE`

The default package URL is:

`https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg`

The package is downloaded into `.runtime/downloads` using a temporary `.part`
file and renamed only after a successful transfer. Before installation:

1. `pkgutil --check-signature` must succeed.
2. The signature output must identify the Python Software Foundation.

The package is installed with:

`sudo installer -pkg <package> -target /`

The installer then re-runs Python detection. A successful `installer` exit
without a supported interpreter is treated as a hard failure.

## Security And Privilege Boundary

- The administrator password is handled exclusively by `sudo`; the project
  never reads, stores, pipes, or logs it.
- Authorization is requested once at the start. Python installation happens
  immediately afterward, so no background sudo keepalive process is needed.
- Only the signed Python.org package is installed with administrator
  privileges.
- Node, ruyiPage, reports, profiles, and generated project files remain under
  the project directory or the current user account.
- Download or signature failure stops before `sudo installer`.
- Existing compatible Python installations are not replaced.

## Failure Handling

- Unsupported macOS/CPU state: stop with a concrete diagnostic.
- User declines or fails sudo authorization: stop before downloads.
- Download failure: remove only the incomplete `.part` file and report the URL.
- Signature mismatch: do not install; retain the package path for inspection.
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
- Signature verification checks for Python Software Foundation.
- `sudo installer -pkg ... -target /` is present.
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
