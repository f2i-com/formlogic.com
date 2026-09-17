# formlogic-python/1 entry: a syntax check - does the author's block COMPILE?
#
# The compile IS the check, and the project does it: ZIPP compiles every project module
# something in the project imports, even from a function that never runs (an import that is
# never reached still names the module), and it EXECUTES a module only when an import of it
# actually runs. So a block that does not parse fails while the project is being set up, with
# a `source` error on the author's own line; a block that parses leaves nothing left to check;
# and in neither case has a statement of the block run. The import at the foot of this module
# is what makes that true - delete it and every block compiles clean - so a corpus case pins it.
#
# Which is why the function a caller reaches is NOT the one that imports it. FormLogic's own
# host calls nothing here - it builds the project and stops - but a consumer unfolding the
# served profile calls this mode's `call` as it calls every other mode's, and an
# `import logic_block` in THAT function would execute the author's top level: a syntax check
# with side effects, which is the one thing this mode exists not to have. The import therefore
# lives where it is compiled and never run, and the call answers the same None the host does.
def __formlogic_compiled__():
    return None


def _compiles_logic_block():
    import logic_block
