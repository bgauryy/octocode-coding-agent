import pathlib, runpy, sys
folder = pathlib.Path(__file__).resolve().parent
sys.argv.extend(["--cases", str(folder / "read-operand-cases.json")])
runpy.run_path(str(folder / "grammar.py"), run_name="__main__")
