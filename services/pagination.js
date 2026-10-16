async function collectPages(fetchPage) {
    const all = [];
    let offset = 0;
    for (let page = 0; page < 10000; page++) {
        const response = await fetchPage(offset);
        const total = response?.pagination?.totalResults;
        const limit = response?.pagination?.limit;
        if (!Array.isArray(response?.results) || !Number.isInteger(total) || total < 0 || !Number.isInteger(limit) || limit < 1) {
            throw Object.assign(new Error('Autodesk returned incomplete pagination information. Refresh and try again.'), { status: 502 });
        }
        all.push(...response.results);
        offset += limit;
        if (offset >= total) return all;
        if (!response.results.length) throw Object.assign(new Error('Autodesk returned an empty page before the end of the result set.'), { status: 502 });
    }
    throw Object.assign(new Error('The Autodesk result set exceeded the pagination limit.'), { status: 502 });
}
module.exports = { collectPages };
