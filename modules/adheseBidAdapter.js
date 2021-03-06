'use strict';

import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER, VIDEO } from '../src/mediaTypes.js';

const BIDDER_CODE = 'adhese';
const USER_SYNC_BASE_URL = 'https://user-sync.adhese.com/iframe/user_sync.html';

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER, VIDEO],

  isBidRequestValid: function(bid) {
    return !!(bid.params.account && bid.params.location && (bid.params.format || bid.mediaTypes.banner.sizes));
  },

  buildRequests: function(validBidRequests, bidderRequest) {
    if (validBidRequests.length === 0) {
      return null;
    }
    const { gdprConsent, refererInfo } = bidderRequest;

    const account = getAccount(validBidRequests);
    const targets = validBidRequests.map(bid => bid.params.data).reduce(mergeTargets, {});
    const gdprParams = (gdprConsent && gdprConsent.consentString) ? [`xt${gdprConsent.consentString}`] : [];
    const refererParams = (refererInfo && refererInfo.referer) ? [`xf${base64urlEncode(refererInfo.referer)}`] : [];
    const id5Params = (getId5Id(validBidRequests)) ? [`x5${getId5Id(validBidRequests)}`] : [];
    const targetsParams = Object.keys(targets).map(targetCode => targetCode + targets[targetCode].join(';'));
    const slotsParams = validBidRequests.map(bid => 'sl' + bidToSlotName(bid));
    const params = [...slotsParams, ...targetsParams, ...gdprParams, ...refererParams, ...id5Params].map(s => `/${s}`).join('');
    const cacheBuster = '?t=' + new Date().getTime();
    const uri = 'https://ads-' + account + '.adhese.com/json' + params + cacheBuster;

    return {
      method: 'GET',
      url: uri,
      bids: validBidRequests
    };
  },

  interpretResponse: function(serverResponse, request) {
    const serverAds = serverResponse.body.reduce(function(map, ad) {
      map[ad.slotName] = ad;
      return map;
    }, {});

    serverResponse.account = getAccount(request.bids);

    return request.bids
      .map(bid => ({
        bid: bid,
        ad: serverAds[bidToSlotName(bid)]
      }))
      .filter(item => item.ad)
      .map(item => adResponse(item.bid, item.ad));
  },

  getUserSyncs: function(syncOptions, serverResponses, gdprConsent) {
    if (syncOptions.iframeEnabled && serverResponses.length > 0) {
      const account = serverResponses[0].account;
      if (account) {
        let syncurl = USER_SYNC_BASE_URL + '?account=' + account;
        if (gdprConsent) {
          syncurl += '&gdpr=' + (gdprConsent.gdprApplies ? 1 : 0);
          syncurl += '&consentString=' + encodeURIComponent(gdprConsent.consentString || '');
        }
        return [{type: 'iframe', url: syncurl}];
      }
    }
    return [];
  }
};

function adResponse(bid, ad) {
  const price = getPrice(ad);
  const adDetails = getAdDetails(ad);
  const markup = getAdMarkup(ad);

  const bidResponse = getbaseAdResponse({
    requestId: bid.bidId,
    mediaType: getMediaType(markup),
    cpm: Number(price.amount),
    currency: price.currency,
    width: Number(ad.width),
    height: Number(ad.height),
    creativeId: adDetails.creativeId,
    dealId: adDetails.dealId,
    adhese: {
      originData: adDetails.originData,
      origin: adDetails.origin,
      originInstance: adDetails.originInstance
    }
  });

  if (bidResponse.mediaType === VIDEO) {
    bidResponse.vastXml = markup;
  } else {
    const counter = ad.impressionCounter ? "<img src='" + ad.impressionCounter + "' style='height:1px; width:1px; margin: -1px -1px; display:none;'/>" : '';
    bidResponse.ad = markup + counter;
  }
  return bidResponse;
}

function mergeTargets(targets, target) {
  if (target) {
    Object.keys(target).forEach(function (key) {
      const val = target[key];
      const values = Array.isArray(val) ? val : [val];
      if (targets[key]) {
        const distinctValues = values.filter(v => targets[key].indexOf(v) < 0);
        targets[key].push.apply(targets[key], distinctValues);
      } else {
        targets[key] = values;
      }
    });
  }
  return targets;
}

function bidToSlotName(bid) {
  if (bid.params.format) {
    return bid.params.location + '-' + bid.params.format;
  }

  var sizes = bid.mediaTypes.banner.sizes;
  sizes.sort();
  var format = sizes.map(size => size[0] + 'x' + size[1]).join('_');

  if (format.length > 0) {
    return bid.params.location + '-' + format;
  } else {
    return bid.params.location;
  }
}

function getAccount(validBidRequests) {
  return validBidRequests[0].params.account;
}

function getId5Id(validBidRequests) {
  if (validBidRequests[0] && validBidRequests[0].userId && validBidRequests[0].userId.id5id) {
    return validBidRequests[0].userId.id5id;
  }
}

function getbaseAdResponse(response) {
  return Object.assign({ netRevenue: true, ttl: 360 }, response);
}

function isAdheseAd(ad) {
  return !ad.origin || ad.origin === 'JERLICIA' || ad.origin === 'DALE';
}

function getMediaType(markup) {
  const isVideo = markup.trim().toLowerCase().match(/<\?xml|<vast/);
  return isVideo ? VIDEO : BANNER;
}

function getAdMarkup(ad) {
  if (!isAdheseAd(ad) || (ad.ext === 'js' && ad.body !== undefined && ad.body !== '' && ad.body.match(/<script|<SCRIPT|<html|<HTML|<\?xml/))) {
    return ad.body
  } else {
    return ad.tag;
  }
}

function getPrice(ad) {
  if (ad.extension && ad.extension.prebid && ad.extension.prebid.cpm) {
    return ad.extension.prebid.cpm;
  }
  return { amount: 0, currency: 'USD' };
}

function getAdDetails(ad) {
  let creativeId = '';
  let dealId = '';
  let originData = {};
  let origin = '';
  let originInstance = '';

  if (isAdheseAd(ad)) {
    creativeId = ad.id;
    dealId = ad.orderId;
    originData = { priority: ad.priority, orderProperty: ad.orderProperty, adFormat: ad.adFormat, adType: ad.adType, libId: ad.libId, adspaceId: ad.adspaceId, viewableImpressionCounter: ad.viewableImpressionCounter, slotId: ad.slotID, slotName: ad.slotName, advertiserId: ad.advertiserId, adId: ad.id };
  } else {
    creativeId = ad.origin + (ad.originInstance ? '-' + ad.originInstance : '');
    if (ad.originData) {
      originData = ad.originData;
      originData.slotId = ad.slotID;
      originData.slotName = ad.slotName;
      originData.adType = ad.adType;
      if (ad.adFormat) originData.adFormat = ad.adFormat;
      if (ad.originData.seatbid && ad.originData.seatbid.length) {
        const seatbid = ad.originData.seatbid[0];
        if (seatbid.bid && seatbid.bid.length) {
          const bid = seatbid.bid[0];
          creativeId = String(bid.crid || '');
          dealId = String(bid.dealid || '');
        }
      }
    }
    if (ad.originInstance) originInstance = ad.originInstance;
    if (ad.origin) origin = ad.origin;
  }
  return { creativeId: creativeId, dealId: dealId, originData: originData, origin: origin, originInstance: originInstance };
}

function base64urlEncode(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

registerBidder(spec);
