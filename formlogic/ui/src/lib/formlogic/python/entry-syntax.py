# formlogic-python/1 entry: a syntax check. A project module is compiled when the project
# initializes even if only a function that never runs imports it, so this compiles
# logic_block and runs none of it.
def __formlogic_never__():
    import logic_block
