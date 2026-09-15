# formlogic-python/1 entry: a flow logic_block written as one expression.
import formlogic as _fl


def __formlogic_run__(ctx):
    _fl._bind(ctx)
    import logic_block
    return _fl._plain(logic_block.__formlogic_value__())
