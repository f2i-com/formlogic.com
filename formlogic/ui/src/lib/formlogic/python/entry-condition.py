# formlogic-python/1 entry: a flow condition, one expression judged by Python truthiness.
import formlogic as _fl


def __formlogic_run__(ctx):
    _fl._bind(ctx)
    import logic_block
    return bool(logic_block.__formlogic_condition__())
