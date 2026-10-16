function statusCode(err) {
    return err.response?.status || err.axiosError?.response?.status || err.statusCode || err.status || (typeof err.httpStatusCode === 'function' ? err.httpStatusCode() : undefined);
}
function message(err) {
    const data = err.response?.data || err.axiosError?.response?.data;
    return String(data?.message || data?.detail || err.message || 'Autodesk request failed.').slice(0, 1000);
}
module.exports = { statusCode, message };
