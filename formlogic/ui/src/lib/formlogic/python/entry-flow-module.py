# formlogic-python/1 entry: a flow logic_block written as statements. Its top-level
# `result` is the value, None when it never sets one.
import formlogic as _fl


def __formlogic_run__(ctx):
    _fl._bind(ctx)
    import logic_block
    return _fl._plain(getattr(logic_block, "result", None))
