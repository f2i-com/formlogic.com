# formlogic-python/1 entry: an app-logic script. The value is run(ctx)'s return, None when
# the script defines no run.
import formlogic as _fl


def __formlogic_run__(ctx):
    import logic_block
    run = getattr(logic_block, "run", None)
    return _fl._plain(run(ctx)) if callable(run) else None
