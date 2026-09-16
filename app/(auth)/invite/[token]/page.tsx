import InviteAcceptClient from './InviteAcceptClient'

export default function InvitePage({ params }: { params: { token: string } }) {
  return <InviteAcceptClient token={params.token} />
}
