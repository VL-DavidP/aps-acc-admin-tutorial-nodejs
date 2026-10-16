const express = require('express');
const crypto = require('node:crypto');
function createAuthRouter({ getAuthorizationUrl, authCallbackMiddleware, authRefreshMiddleware, getUserProfile }) {

let router = express.Router();

router.get('/api/auth/login', function (req, res) {
    req.session.oauthState = crypto.randomBytes(24).toString('hex');
    res.redirect(getAuthorizationUrl(req.session.oauthState));
});

router.get('/api/auth/logout', function (req, res) {
    req.session.destroy(() => res.redirect('/'));
});

router.get('/api/auth/callback', authCallbackMiddleware, function (req, res) {
    res.redirect('/');
});

router.get('/api/auth/profile', authRefreshMiddleware, async function (req, res, next) {
    try {
        const profile = await getUserProfile(req.oAuthToken);
        res.json({ name: `${profile.name}` });
    } catch (err) {
        next(err);
    }
});
router.use('/api/auth/callback', (err, req, res, next) => {
    res.redirect('/?authError=' + encodeURIComponent('Autodesk sign-in could not be completed. Start sign-in again. Check that this app uses the callback URL registered in APS.'));
});

return router;
}
module.exports = { createAuthRouter };
