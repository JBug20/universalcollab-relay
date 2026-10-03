"""rc.2 packaging entry point; build/obfuscate.cjs must run first."""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).with_name('package-rc2.py')),run_name='__main__')
