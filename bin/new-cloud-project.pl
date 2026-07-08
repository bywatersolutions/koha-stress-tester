#!/usr/bin/perl

# new-cloud-project.pl - Create a new Grafana Cloud k6 project and fill it with
# the four Koha stress-test templates - one command, no web-UI clicking, no
# manual paste. Anyone with 'k6 cloud login' done can stand up a whole project
# of clone-and-run tests for a partner or engagement.
#
# Usage:
#   ./bin/new-cloud-project.pl "Partner X - Stress Tests"
#   ./bin/new-cloud-project.pl "Foo" --org 3432454 --dry-run
#
# Needs 'k6 cloud login --token <token>' once first ( token from the Grafana
# Cloud k6 app ). Runners then open the project, clone a test, edit the values
# marked "<<< SET", and Run - see docs/GRAFANA_CLOUD.md.
#
# ( VU limits can't be set through the API - that's an admin/plan action in the
# UI - so raise them there if a big run needs more than the project default. )

use Modern::Perl;
use Getopt::Long;
use FindBin;
use HTTP::Tiny;
use JSON::PP;

my ( $org_override, $dry_run, $help );
GetOptions(
    'org=s'   => \$org_override,
    'dry-run' => \$dry_run,
    'help'    => \$help,
) or die "Try --help\n";

_usage() if $help;

my $name = shift @ARGV;
die "Usage: $0 \"<project name>\" [--org ID] [--dry-run]\n"
    unless defined $name && length $name;
die "Unexpected extra arguments: @ARGV\n" if @ARGV;

my $token = _k6_token();
my $http  = HTTP::Tiny->new;

# Discover the org ( unless given )
my $org = $org_override;
unless ( defined $org && length $org ) {
    my $res = _api( 'GET', "https://api.k6.io/v3/organizations" );
    die "Error: could not discover organization (HTTP $res->{status})\n" unless $res->{success};
    my $orgs = decode_json( $res->{content} )->{organizations} || [];
    die "Error: no organizations found for this token.\n" unless @$orgs;
    if ( @$orgs > 1 ) {
        say STDERR "Multiple orgs found - pass --org <id>:";
        say STDERR "  $_->{id}  $_->{name}" for @$orgs;
        exit 1;
    }
    $org = $orgs->[0]{id};
}

if ($dry_run) {
    say "DRY: would create project '$name' in org $org, then populate 4 templates";
    exit 0;
}

# Create the project ( POST returns 201 )
my $res = _api( 'POST', "https://api.k6.io/v3/projects",
    { name => $name, organization_id => int($org) } );
die "Error: create project failed HTTP $res->{status}: " . _short( $res->{content} ) . "\n"
    unless $res->{success};
my $pid = decode_json( $res->{content} )->{project}{id}
    or die "Error: project created but no id returned.\n";
say "Created project '$name' (id $pid) in org $org";

# Populate the four templates by handing off to the sync script
say "\nPopulating the four templates into project $pid ...";
my $sync = "$FindBin::Bin/sync-cloud-tests.pl";
system( $^X, $sync, '--project', $pid ) == 0
    or die "Populating templates failed.\n";

say "";
say "=" x 42;
say "Project ready:";
say "  https://bws.grafana.net/a/k6-app/projects/$pid";
say "";
say "Runners: open a test, clone it ( Save as... ), edit the <<< SET values,";
say "and Run.  See docs/GRAFANA_CLOUD.md.";
say "";
say "Secrets ( staff-pass, the ingress token ) are org-wide, so they apply";
say "here automatically. Target servers need RESTBasicAuth enabled.";
say "";
say "Note: the project uses default VU limits - big runs ( e.g. the OPAC peak )";
say "may need them raised in the UI ( project settings / Grafana support ).";
say "=" x 42;

# ------------------------------------------------------------

sub _api {
    my ( $method, $url, $body ) = @_;
    my %opts = ( headers => { Authorization => "Bearer $token" } );
    if ( defined $body ) {
        $opts{headers}{'Content-Type'} = 'application/json';
        $opts{content} = encode_json($body);
    }
    return $http->request( $method, $url, \%opts );
}

sub _k6_token {
    my $cfg = "$ENV{HOME}/Library/Application Support/k6/config.json";
    die "Error: k6 config not found at $cfg - run 'k6 cloud login --token <token>' first.\n"
        unless -f $cfg;
    open my $fh, '<', $cfg or die "Cannot read $cfg: $!\n";
    local $/;
    my $data = decode_json(<$fh>);
    my $tok = $data->{collectors}{cloud}{token}
        or die "Error: no cloud token in $cfg - run 'k6 cloud login' first.\n";
    return $tok;
}

sub _short { my ($s) = @_; $s //= ''; $s =~ s/\s+/ /g; return substr( $s, 0, 200 ); }

# Print the leading comment block ( the usage header ) and exit.
sub _usage {
    open my $fh, '<', $0 or exit 1;
    my $seen;
    while ( my $l = <$fh> ) {
        next if $l =~ /^#!/;                 # skip shebang
        next if !$seen && $l =~ /^\s*$/;     # skip blank lines before the header
        last unless $l =~ /^#/;              # stop at the first non-comment line
        $seen = 1;
        $l =~ s/^# ?//;
        print $l;
    }
    exit 0;
}
