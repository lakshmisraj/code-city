"""Puts the ask server (local/ask-server.mjs bundled with ask.mjs and its packages) into the wheel.

When npm is available it bundles afresh (npm run bundle:ask), so a release always carries the current ask.mjs.
Without npm it uses build/ask-server.mjs if there is one, or leaves Ask out: code-city then runs without it.
"""
import os
import shutil
import subprocess

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class AskBundle(BuildHookInterface):
    def initialize(self, version, build_data):
        if self.target_name != "wheel":
            return
        out = os.path.join(self.root, "build", "ask-server.mjs")
        npm = shutil.which("npm")
        if npm and os.path.isfile(os.path.join(self.root, "package.json")):
            if not os.path.isdir(os.path.join(self.root, "node_modules", "esbuild")):
                subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=self.root, check=True)
            subprocess.run([npm, "run", "--silent", "bundle:ask"], cwd=self.root, check=True)
        if os.path.isfile(out):
            build_data["force_include"][out] = "codecity_assets/ask-server.mjs"
            legal = out + ".LEGAL.txt"
            if os.path.isfile(legal):
                build_data["force_include"][legal] = "codecity_assets/ask-server.mjs.LEGAL.txt"
        else:
            self.app.display_warning("No npm, so this code-city has no Ask: build it where Node is installed to include it.")
