"""Check shipped framing headers with Windows Apache, including nested .htaccess rules.
Run: python scripts/test-apache-framing.py --httpd /path/to/httpd --server-root /path/to/apache
"""
import argparse
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--httpd', required=True)
parser.add_argument('--server-root', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
apache = Path(args.server_root).resolve()
parent = Path(tempfile.gettempdir()).resolve()
root = Path(tempfile.mkdtemp(prefix='formlogic-apache-framing-', dir=parent)).resolve()
process = None
try:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    web = root / 'web'
    web.mkdir()
    shutil.copyfile(repo / 'formlogic/ui/public/.htaccess', web / '.htaccess')
    for name in ['index.html', 'screen-host.html', 'hosted-runtime/index.html', 'app-editors/builder/index.html', 'app-editors/studio/index.html']:
        path = web / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('<!doctype html><title>Frame header fixture</title>Ready')
    # The generated runtime supplies CORS in a child .htaccess; it must not undo
    # the parent entry-document framing policy.
    (web / 'hosted-runtime/.htaccess').write_text('<IfModule mod_headers.c>\nHeader always set Access-Control-Allow-Origin "*"\n</IfModule>\n')
    modules = ['authz_core', 'authz_host', 'headers', 'setenvif', 'rewrite', 'dir', 'mime']
    config = root / 'httpd.conf'
    config.write_text(f'''ServerRoot "{apache.as_posix()}"
Listen 127.0.0.1:{port}
ServerName 127.0.0.1
PidFile "{(root / 'httpd.pid').as_posix()}"
ErrorLog "{(root / 'error.log').as_posix()}"
DocumentRoot "{web.as_posix()}"
''' + ''.join(f'LoadModule {name}_module modules/mod_{name}.so\n' for name in modules) + f'''
TypesConfig "{(apache / 'conf/mime.types').as_posix()}"
DirectoryIndex index.html
<Directory "{web.as_posix()}">
  AllowOverride All
  Require all granted
</Directory>
''')
    subprocess.run([args.httpd, '-t', '-f', str(config)], check=True)
    process = subprocess.Popen([args.httpd, '-f', str(config), '-X'], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try:
            with urllib.request.urlopen(base, timeout=1):
                break
        except OSError:
            if process.poll() is not None:
                raise RuntimeError((root / 'error.log').read_text())
            time.sleep(.1)
    cases = {'/': ('none', 'DENY'), '/app/example': ('none', 'DENY'), '/settings': ('none', 'DENY'), '/screen-host.html': ('self', 'SAMEORIGIN'), '/hosted-runtime/index.html': ('self', 'SAMEORIGIN'), '/hosted-runtime/': ('self', 'SAMEORIGIN'), '/app-editors/builder/index.html': ('self', 'SAMEORIGIN'), '/app-editors/studio/index.html': ('self', 'SAMEORIGIN'), '/form/example': ('*', None)}
    for path, (ancestor, frame) in cases.items():
        with urllib.request.urlopen(base + path) as response:
            expected = f"frame-ancestors '{ancestor}'" if ancestor != '*' else 'frame-ancestors *'
            assert response.headers.get_all('Content-Security-Policy') == [expected + "; base-uri 'self'; object-src 'none'"], (path, str(response.headers))
            assert response.headers.get('X-Frame-Options') == frame, (path, str(response.headers))
            if path.startswith('/hosted-runtime/'):
                assert response.headers.get('Access-Control-Allow-Origin') == '*'
            print(path + ': framing headers correct')
finally:
    if process is not None:
        process.terminate()
        process.wait(timeout=10)
    assert root.parent == parent and root.name.startswith('formlogic-apache-framing-')
    shutil.rmtree(root)
