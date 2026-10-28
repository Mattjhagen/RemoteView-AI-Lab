"""Explicit inference payload boundary: never accept a session, trial, or target object."""
def payload(model, messages, options=None):
    result = {'model': model, 'messages': [
        {'role': entry['role'], 'content': entry['content']} for entry in messages], 'stream': False}
    if options is not None:
        result['options'] = dict(options)
    return result
