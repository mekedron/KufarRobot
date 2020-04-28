const storage = {}

const getCached = async function (key) {
  return storage[key]
}

const setCached = async function (key, value) {
  storage[key] = value
}

module.exports = {
  getCached: getCached,
  setCached: setCached
}
