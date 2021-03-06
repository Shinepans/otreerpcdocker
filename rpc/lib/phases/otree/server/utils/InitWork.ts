import {NextFunction, Request, Response} from 'express'
import {ErrorPage} from '../../../common/utils'
import ListMap from '../utils/ListMap'
import {ThirdPartPhase} from '../../../../core/server/models'
import {elfSetting as elfSetting} from '../../../../../configs/settings'
import {RedisCall, SendBackPlayer} from '../../../common/elfProtocol'
import nodeXlsx from 'node-xlsx'
import {
    downloadScreenXlsxRoute,
    getOTreeListRoute,
    initRoute,
    jqueryRoute,
    previewScreenXlsxRoute,
    reportScreenRoute,
    virtualJsRoute
} from '../config'
import * as path from 'path'

const START_SIGN = 'InitializeParticipant'
const {oTreeProxy} = elfSetting

export const InitWork = (app) => {
    app.use(async (req: Request, res: Response, next: NextFunction) => {
        const originWrite = res.write
        const originEnd = res.end

        const okRes = () => {
            res.write = originWrite
            res.end = originEnd
            return res
        }

        const noRes = () => {
            res.write = () => true
            res.end = () => null
        }

        noRes()

        if (req.url.includes(virtualJsRoute)) {
            okRes().setHeader('Content-Type', 'text/javascript')
            return okRes().end(`window.registerOtreePhase("${elfSetting.oTreeNamespace}","${elfSetting.oTreeProxy}")`)
        }

        if (req.url.includes(getOTreeListRoute)) {
            const list = await ListMap.getList(elfSetting.oTreeNamespace)
            return okRes().json({err: 0, list})
        }

        if (req.url.includes(reportScreenRoute)) {
            const phaseId = req.session.oTreePhaseId
            const gameServicePlayerHash = req.session.token
            const phase = await ThirdPartPhase.findById(phaseId)
            const curPlayer = phase.playHash.filter(p => p.player.toString() === gameServicePlayerHash.toString())[0]
            if (!curPlayer.hash) return ErrorPage(res, 'Wrong Player')

            let jsonString = '', playerOtreeHash = ''
            playerOtreeHash = curPlayer.hash

            req.on('data', (data) => {
                jsonString += data
            })
            req.on('end', async () => {
                const body = JSON.parse(jsonString)
                for (let ph of phase.playHash) {
                    if (ph.player === gameServicePlayerHash) {
                        ph.screen = JSON.stringify({winW: body.winW, winH: body.winH})
                        ph.referer = req.headers.referer
                        ph.userAgent = req.headers['user-agent']
                        ph.ipAddress = req.headers['x-forwarded-for'] as string || req.connection.remoteAddress
                        let os = {android: false, iphone: false, ios: false, version: undefined}
                        const android = ph.userAgent.match(/(Android);?[\s\/]+([\d.]+)?/)
                        const iPad = ph.userAgent.match(/(iPad).*OS\s([\d_]+)/)
                        const iPhone = !iPad && ph.userAgent.match(/(iPhone\sOS)\s([\d_]+)/)
                        const iPod = ph.userAgent.match(/(iPod)(.*OS\s([\d_]+))?/)
                        if (android) {
                            os.android = true
                            os.version = android[2]
                        }
                        if (iPhone && !iPod) {
                            os.ios = os.iphone = true
                            os.version = iPhone[2].replace(/_/g, '.')
                        }
                        if (os.android) {
                            ph.userSystem = 'Android'
                            ph.userSystemVersion = os.version
                        } else if (os.ios) {
                            ph.userSystem = 'ios'
                            ph.userSystemVersion = os.version
                        } else if (ph.userAgent.indexOf('Windows NT') > -1) {
                            ph.userSystem = 'Windows OS'
                            ph.userSystemVersion = ph.userAgent.split('(')[1].split(')')[0]
                        } else if (ph.userAgent.indexOf('Mac') > -1) {
                            ph.userSystem = 'Mac OS'
                            ph.userSystemVersion = ph.userAgent.split('(')[1].split(')')[0]
                        } else {
                            ph.userSystem = 'unknown'
                            ph.userSystemVersion = 'unknown'
                        }
                        break
                    }
                }
                phase.markModified('playHash')
                await phase.save()
                await RedisCall.call<SendBackPlayer.IReq, SendBackPlayer.IRes>(SendBackPlayer.name, {
                    elfGameId: phase.elfGameId,
                    playUrl: `${oTreeProxy}/init/${START_SIGN}/${phase._id}`,
                    playerToken: gameServicePlayerHash,
                    phaseResult: {
                        uniKey: playerOtreeHash,
                        detailIframeUrl: `${oTreeProxy}${previewScreenXlsxRoute}/${phaseId}`
                    }
                })
                return okRes().json({code: 0, msg: 'reported'})
            })
        }

        if (req.url.includes(jqueryRoute)) {
            return okRes().sendFile(path.resolve(__dirname, './hack.js'))
        }

        if (req.url.includes(initRoute)) {
            let findHash: string
            const gameServicePlayerHash = req.session.token
            const phaseId = req.path.split(`${START_SIGN}/`)[1]

            try {
                const phase = await ThirdPartPhase.findById(phaseId).exec()

                if (!phase) {
                    return ErrorPage(okRes(), 'Phase Not Found')
                }

                req.session.oTreePhaseId = phase._id

                if (phase.ownerToken.toString() === gameServicePlayerHash.toString()) {
                    const phaseParam = JSON.parse(phase.param)
                    return okRes().redirect(phaseParam.adminUrl)
                }

                const findExistOne = phase.playHash.filter(h => h.player === gameServicePlayerHash)
                if (findExistOne.length > 0) {
                    return okRes().redirect(`${elfSetting.oTreeProxy}/${START_SIGN}/${findExistOne[0].hash}`)
                } else {
                    for (let ph of phase.playHash) {
                        if (ph.player === 'wait') {
                            findHash = ph.hash
                            ph.player = gameServicePlayerHash
                            break
                        }
                    }
                    if (!findHash) return ErrorPage(okRes(), 'member full')
                    phase.markModified('playHash')
                    await phase.save()
                    return okRes().redirect(`${elfSetting.oTreeProxy}/${START_SIGN}/${findHash}`)
                }
            } catch (err) {
                if (err) {
                    console.trace(err)
                    return ErrorPage(okRes(), err)
                }
            }
        }

        if (req.url.includes(previewScreenXlsxRoute)) {
            const [, , phaseId] = req.url.split('/')
            const screens = (await ThirdPartPhase.findById(phaseId)).playHash
                .filter(({screen}) => screen)
                .map(({hash, screen, ipAddress, userAgent, userSystem, userSystemVersion}) => {
                    const {winW, winH} = JSON.parse(screen)
                    return {hash, winW, winH, ipAddress, userAgent, userSystem, userSystemVersion}
                })
            return okRes().render('previewScreenXlsx', {
                phaseId,
                screens
            })
        }
        if (req.url.includes(downloadScreenXlsxRoute)) {
            const [, , phaseId] = req.url.split('/')
            const data = (await ThirdPartPhase.findById(phaseId)).playHash
                .filter(({screen}) => screen)
                .map(({hash, screen, ipAddress, userAgent, userSystem, userSystemVersion}) => {
                    const {winW, winH} = JSON.parse(screen)
                    return [hash, winW, winH, ipAddress, userAgent, userSystem, userSystemVersion]
                })
            data.unshift(['Player', 'ScreenWidth(px)', 'ScreenHeight(px)', 'IP Address', 'User Agent', 'User System', 'User System Version'])
            const name = 'ScreenSize'
            let buffer = nodeXlsx.build([{name, data}], {})
            res.setHeader('Content-Type', 'application/vnd.openxmlformats')
            res.setHeader('Content-Disposition', 'attachment; filename=' + `${encodeURI(name)}.xlsx`)
            return okRes().end(buffer, 'binary')
        }
        okRes()
        next()
    })
}
