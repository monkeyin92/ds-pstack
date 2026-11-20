export function sessionLog(header) {
  const events = []
  return {
    header,
    snapshotEvents: (from = 0) => events.slice(from),
    append(event) { events.push({ ...structuredClone(event), seq: events.length }) },
  }
}

export function appendPluginRecord(session, type, data) {
  session.append({ type, data, ignorable: true })
}

export function sessionModel(session, initial) {
  let selection = { ...initial }
  return {
    current: () => ({ ...selection }),
    select(value) {
      session.append({ type: 'model/selection', data: value })
      selection = { ...value }
    },
  }
}
